import { Tooltip } from "../../components/tooltip.js";
import { Button, Input } from "@heroui/react";
import { storedDesktopEnvelopeSchema as envelopeSchema } from "../../../shared/desktop/desktop-commands.js";
import type { DesktopEnvelope as Envelope } from "../../../shared/desktop/desktop-commands.js";
import { useEffect, useRef, useState } from "react";
import { AppError } from "../../../shared/core.js";
import type {
  Question,
  QuestionAnswer,
} from "../../../shared/chat/questions.js";
import { envelope, errorMessage } from "../../lib/client.js";
import { useMessageCapabilities } from "./message-capabilities.js";
import { Icon } from "../../components/icons.js";
import "./question-card.css";

export function QuestionCard({ question }: { question: Question }) {
  const { execute } = useMessageCapabilities();
  const draftKey = `question-draft:${question.id}`,
    pendingKey = `question-answer:${question.id}`;
  const [saved] = useState(() => {
    try {
      return { text: localStorage.getItem(draftKey) ?? "", error: "" };
    } catch {
      return { text: "", error: "无法读取本机回答草稿，请检查存储是否可用。" };
    }
  });
  const [text, setText] = useState(saved.text);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(saved.error);
  const alive = useRef(true),
    composing = useRef(false),
    currentStatus = useRef(question.status);
  currentStatus.current = question.status;
  const [pending, setPending] = useState<Envelope | null>(() => {
    try {
      const raw: unknown = JSON.parse(
        localStorage.getItem(pendingKey) ?? "null",
      );
      const value = envelopeSchema.safeParse(raw);
      return value.success &&
        value.data.command.type === "question.answer" &&
        value.data.command.id === question.id &&
        value.data.command.conversationId === question.conversationId
        ? value.data
        : null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (question.status !== "pending") {
      setError("");
      try {
        localStorage.removeItem(draftKey);
        localStorage.removeItem(pendingKey);
      } catch {
        setError("问题已处理，但本机草稿缓存未能清理。");
      }
      setPending(null);
    }
  }, [question.status, draftKey, pendingKey]);
  const submit = async (answer: QuestionAnswer["answer"]) => {
    if (busy || question.status !== "pending") return;
    const request =
      pending ??
      envelope({
        type: "question.answer",
        id: question.id,
        conversationId: question.conversationId,
        answer,
      });
    setBusy(true);
    setError("");
    try {
      localStorage.setItem(pendingKey, JSON.stringify(request));
      setPending(request);
      await execute(request);
      try {
        localStorage.removeItem(pendingKey);
        localStorage.removeItem(draftKey);
      } catch {
        if (alive.current) setError("回答已保存，但本机草稿缓存未能清理。");
      }
      if (alive.current) setPending(null);
    } catch (error) {
      // A committed snapshot can arrive before the lost command reply fails.
      if (currentStatus.current !== "pending") return;
      if (
        error instanceof AppError &&
        [
          "invalid_input",
          "conflict",
          "unauthorized",
          "not_found",
          "capacity",
        ].includes(error.code)
      ) {
        try {
          localStorage.removeItem(pendingKey);
        } catch {
          if (alive.current)
            setError(
              `${errorMessage(error)} 本机提交缓存也未能清理，请保持窗口打开。`,
            );
          return;
        }
        if (alive.current) setPending(null);
      }
      if (alive.current) setError(errorMessage(error));
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  return (
    <form
      className={`question-card ${question.status}`}
      aria-label={question.prompt}
      onSubmit={(event) => {
        event.preventDefault();
        if (!composing.current && text.trim())
          void submit({ type: "custom", text });
      }}
    >
      <div className="question-heading">
        <strong>{question.prompt}</strong>
        {question.status === "pending" && (
          <Tooltip content="不回答直接忽略">
            <Button
              variant="ghost"
              size="sm"
              type="button"
              className="question-skip"
              aria-label="忽略问题"
              isDisabled={busy || !!pending}
              onClick={() => {
                void submit({ type: "skip" });
              }}
            >
              <Icon name="close" size={14} />
            </Button>
          </Tooltip>
        )}
      </div>
      {question.status === "pending" ? (
        <>
          <div className="question-options">
            {question.options.map((label, index) => (
              <Button
                variant="ghost"
                size="sm"
                key={index}
                type="button"
                isDisabled={busy || !!pending}
                onClick={() => {
                  void submit({ type: "option", index });
                }}
              >
                <span aria-hidden="true">
                  {String.fromCharCode(65 + index)}
                </span>
                {label}
              </Button>
            ))}
          </div>
          <div className="question-custom">
            <Input
              variant="secondary"
              aria-label="自定义回答"
              placeholder="输入你自己的回答"
              maxLength={4000}
              value={text}
              disabled={busy || !!pending}
              onChange={(event) => {
                const value = event.target.value;
                setText(value);
                try {
                  localStorage.setItem(draftKey, value);
                } catch {
                  setError("回答草稿未能保存，请保持窗口打开后提交。");
                }
              }}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={() => {
                composing.current = false;
              }}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  (composing.current || event.nativeEvent.isComposing)
                )
                  event.preventDefault();
              }}
            />
            {text.trim() && !pending && (
              <Button variant="ghost" size="sm" type="submit" isDisabled={busy}>
                提交
              </Button>
            )}
          </div>
          {pending && (
            <Button
              variant="ghost"
              size="sm"
              type="button"
              isDisabled={busy}
              onClick={() => {
                if (pending.command.type === "question.answer")
                  void submit(pending.command.answer);
              }}
            >
              核实回答结果
            </Button>
          )}
        </>
      ) : (
        <p className="question-result" role="status">
          {question.status === "answered"
            ? `已回答：${question.answer}`
            : question.status === "skipped"
              ? "已忽略这个问题"
              : "运行已停止，这个问题已取消"}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
