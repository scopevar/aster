import { AppOverlays } from "./app-overlays.js";
import { AppTitlebar } from "../components/window/app-titlebar.js";
import { ConversationHeader } from "./conversation-header.js";
import { ConversationWorkspace } from "./conversation-workspace.js";
import "../features/memory/memory.css";
import { Sidebar } from "./sidebar.js";
import "../features/skills/skills.css";
import "../styles/styles.css";
import "../styles/theme.css";
import type { AppViewModel } from "./use-app-session.js";
import { ConversationMessages } from "./conversation-messages.js";
import { MainPage } from "./main-page.js";
import { StartPage } from "./start-page.js";
export function AppView(model: AppViewModel) {
  const {
    copyBotId,
    setCopyBotId,
    deleteTarget,
    setDeleteTarget,
    memoryScope,
    setMemoryScope,
    sharedMemory,
    setSharedMemory,
    skillManager,
    setSkillManager,
    skillPreview,
    setSkillPreview,
    preview,
    setPreview,
    modal,
    setModal,
    templateDraftId,
    setTemplateDraftId,
    settingsTab,
    setSettingsTab,
  } = model.overlays;
  const {
    groupDraft,
    setGroupDraft,
    selected,
    details,
    setDetails,
    historyWindow,
    setHistoryWindow,
    detailsView,
    setDetailsView,
    setFocusDetails,
    suppressedRead,
    reading,
    state,
    connected,
    connectionError,
    current,
    refresh,
    conversation,
    bot,
    newChatReturn,
    select,
    jumpToMessage,
    extendHistory,
    availableBots,
    emptyGroup,
    newChatTarget,
    running,
    allMessages,
  } = model.conversation;
  const {
    fileInput,
    setDrafts,
    input,
    attachments,
    currentUploads,
    uploading,
    addFiles,
    draft,
    setDraft,
    send,
    pendingMessages,
    retrySend,
  } = model.composer;
  const { busy, setBusy, updateConversation, openConversation } =
    model.commands;
  const { submit, act, chain } = model.queue;
  const { preferences, saveDesktopPreferences } = model.desktopPreferences;
  const { sidebarCollapsed, sidebarWidth, resize } = model.sidebar;
  const { setError } = model.errors;
  const {
    routineError,
    setRoutineError,
    openingRoutines,
    open: openRoutines,
  } = model.routines;
  const showConversations = state.conversations.length > 0 || groupDraft;
  const newBot = () => {
    void model.botCreation
      .restoreCreate()
      .then(() => {
        setError("");
        setModal("create");
      })
      .catch((cause: unknown) => setError(String(cause)));
  };
  return (
    <div className="app">
      <AppTitlebar chain={chain} onError={setError} />
      <MainPage
        hidden={modal === "settings"}
        columns={
          showConversations
            ? `60px ${sidebarCollapsed ? 88 : sidebarWidth}px minmax(0, 1fr)`
            : "60px minmax(0, 1fr)"
        }
      >
        <Sidebar
          showConversations={showConversations}
          activePage={modal === "market" ? "market" : "conversations"}
          onConversations={() => setModal(null)}
          onMarket={() => setModal("market")}
          sections={state.sidebar}
          onRefresh={refresh}
          bots={state.bots}
          conversations={state.conversations}
          selected={selected}
          width={sidebarWidth}
          collapsed={sidebarCollapsed}
          onResize={resize}
          onSelect={select}
          onSearch={() => setModal("search")}
          onNewConversation={() => setModal("start")}
          onNewBot={newBot}
          onCreateGroup={() => {
            select(null);
            setGroupDraft(true);
          }}
          onSettings={(tab) => {
            setSettingsTab(tab);
            setModal("settings");
          }}
          onCheck={() => {
            void act({ type: "agent.check" });
          }}
          onUpdate={updateConversation}
          onUnread={async (c) => {
            suppressedRead.current = c.id;
            const result = await act({
              type: "conversation.unread",
              conversationId: c.id,
            });
            if (!result) throw new Error("未读标记未保存。");
          }}
          onRename={(c) => {
            select(c.id);
            setDetails(true);
            setDetailsView("settings");
          }}
          onDelete={(c) => {
            const identity = state.bots.find((b) => b.id === c.botId);
            if (identity)
              setDeleteTarget({
                kind: c.group ? "group" : "bot",
                targetId: c.group ? c.id : c.botId,
                name: c.group?.name ?? identity.name,
              });
          }}
        />
        <ConversationWorkspace
          startPage={
            <StartPage
              active={modal !== "settings"}
              connected={connected}
              bots={availableBots}
              busy={busy}
              onModels={() => {
                setSettingsTab("模型与连接");
                setModal("settings");
              }}
              onNewBot={newBot}
              onSelectBot={openConversation}
            />
          }
          header={
            <ConversationHeader
              state={state}
              select={select}
              bot={bot}
              setDetails={setDetails}
              details={details}
              conversation={conversation}
              setModal={setModal}
              newChatTarget={newChatTarget}
              newChatReturn={newChatReturn}
              setDetailsView={setDetailsView}
              setHistoryWindow={setHistoryWindow}
              setTemplateDraftId={setTemplateDraftId}
              detailsView={detailsView}
              onOpenRoutines={openRoutines}
              openingRoutines={openingRoutines}
            />
          }
          children={
            bot && conversation ? (
              <ConversationMessages
                state={state}
                setError={setError}
                bot={bot}
                conversation={conversation}
                setModal={setModal}
                openConversation={openConversation}
                setHistoryWindow={setHistoryWindow}
                setTemplateDraftId={setTemplateDraftId}
                connected={connected}
                onOpenRoutines={openRoutines}
                preferences={preferences}
                modal={modal}
                preview={preview}
                memoryScope={memoryScope}
                skillManager={skillManager}
                skillPreview={skillPreview}
                suppressedRead={suppressedRead}
                reading={reading}
                act={act}
                setPreview={setPreview}
                setSkillPreview={setSkillPreview}
                current={current}
                input={input}
                historyWindow={historyWindow}
                allMessages={allMessages}
                pendingMessages={pendingMessages}
                retrySend={retrySend}
                extendHistory={extendHistory}
                refresh={refresh}
              />
            ) : null
          }
          groupDraft={groupDraft}
          availableBots={availableBots}
          state={state}
          attachments={attachments}
          submit={submit}
          select={select}
          setGroupDraft={setGroupDraft}
          bot={bot}
          details={details}
          conversation={conversation}
          openConversation={openConversation}
          detailsView={detailsView}
          addFiles={addFiles}
          connected={connected}
          connectionError={connectionError}
          onOpenRoutines={openRoutines}
          act={act}
          setMemoryScope={setMemoryScope}
          composer={{
            state: state,
            attachments: attachments,
            submit: submit,
            setError: setError,
            bot: bot,
            setDetails: setDetails,
            conversation: conversation,
            onOpenSettings: (tab) => {
              setSettingsTab(tab);
              setModal("settings");
            },
            setDetailsView: setDetailsView,
            busy: busy,
            addFiles: addFiles,
            connected: connected,
            preferences: preferences,
            act: act,
            setPreview: setPreview,
            setSkillPreview: setSkillPreview,
            input: input,
            emptyGroup: emptyGroup,
            fileInput: fileInput,
            currentUploads: currentUploads,
            setFocusDetails: setFocusDetails,
            setBusy: setBusy,
            saveDesktopPreferences: saveDesktopPreferences,
            setSkillManager: setSkillManager,
            setDrafts: setDrafts,
            draft: draft,
            setDraft: setDraft,
            send: send,
            running: running,
            uploading: uploading,
          }}
        />
      </MainPage>
      <AppOverlays
        botCreation={model.botCreation}
        onNewBot={newBot}
        select={select}
        openConversation={openConversation}
        modal={modal}
        state={state}
        setModal={setModal}
        bot={bot}
        setDetails={setDetails}
        setDetailsView={setDetailsView}
        conversation={conversation}
        setCopyBotId={setCopyBotId}
        setMemoryScope={setMemoryScope}
        setTemplateDraftId={setTemplateDraftId}
        setSettingsTab={setSettingsTab}
        jumpToMessage={jumpToMessage}
        preview={preview}
        setPreview={setPreview}
        setError={setError}
        memoryScope={memoryScope}
        submit={submit}
        skillManager={skillManager}
        setSkillManager={setSkillManager}
        skillPreview={skillPreview}
        setSkillPreview={setSkillPreview}
        settingsTab={settingsTab}
        preferences={preferences}
        saveDesktopPreferences={saveDesktopPreferences}
        setSharedMemory={setSharedMemory}
        sharedMemory={sharedMemory}
        copyBotId={copyBotId}
        templateDraftId={templateDraftId}
        running={running}
        deleteTarget={deleteTarget}
        setDeleteTarget={setDeleteTarget}
        refresh={refresh}
        routineError={routineError}
        setRoutineError={setRoutineError}
      />
    </div>
  );
}
