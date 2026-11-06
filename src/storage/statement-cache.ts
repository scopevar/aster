import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
  type StatementSync,
} from "node:sqlite";

/** 上限远大于代码中固定 SQL 的种类数；只用来兜住拼接出来的动态 SQL，避免缓存无界增长。 */
const maxStatements = 512;

function changesSchema(sql: string): boolean {
  return /\b(?:CREATE|ALTER|DROP|REINDEX|VACUUM|ATTACH|DETACH|ROLLBACK)\b/i.test(
    sql,
  );
}

function namedParameters(
  value: SQLInputValue | Record<string, SQLInputValue>,
): value is Record<string, SQLInputValue> {
  return (
    typeof value === "object" && value !== null && !ArrayBuffer.isView(value)
  );
}

/**
 * [Perf]: 存储层所有模块都以 `db.prepare(sql)` 现编现用，一次快照要编译上千条语句，约占快照耗时一半。
 * 按 SQL 文本复用已编译语句；调用方写法不变。
 * [Invariant]: 同一条 SQL 的 `.iterate()` 尚未遍历完时不得再次执行它，缓存层显式拒绝重入，
 * 避免不同 Node 版本静默截断迭代结果。现有 iterate 循环体内都只执行其他 SQL。
 */
export class CachedDatabase extends DatabaseSync {
  private readonly statements = new Map<string, StatementSync>();
  private readonly iterating = new WeakSet<StatementSync>();

  override exec(sql: string): void {
    // [Platform]: Node 24.13 自动重编译后仍可能沿用旧列元数据；DDL 后必须重新 prepare。
    if (changesSchema(sql)) this.statements.clear();
    super.exec(sql);
  }

  override prepare(sql: string): StatementSync {
    if (changesSchema(sql)) {
      this.statements.clear();
      return super.prepare(sql);
    }
    const cached = this.statements.get(sql);
    if (cached) {
      if (this.iterating.has(cached)) {
        throw new Error(
          "iterator was invalidated: cached statement is still being iterated",
        );
      }
      // Map 按插入顺序迭代：删除后重新插入即标记为最近使用。
      this.statements.delete(sql);
      this.statements.set(sql, cached);
      return cached;
    }
    const statement = super.prepare(sql);
    const iterate = statement.iterate.bind(statement);
    const iterating = this.iterating;
    statement.iterate = function* (
      ...parameters: Array<SQLInputValue | Record<string, SQLInputValue>>
    ): Generator<Record<string, SQLOutputValue>, undefined, unknown> {
      if (iterating.has(statement)) {
        throw new Error(
          "iterator was invalidated: cached statement is still being iterated",
        );
      }
      const [first, ...rest] = parameters;
      const anonymous = rest.map((value) => {
        if (namedParameters(value))
          throw new TypeError("Unexpected named SQL parameters");
        return value;
      });
      iterating.add(statement);
      try {
        if (first === undefined) yield* iterate();
        else if (namedParameters(first)) yield* iterate(first, ...anonymous);
        else yield* iterate(first, ...anonymous);
      } finally {
        iterating.delete(statement);
      }
      return undefined;
    };
    this.statements.set(sql, statement);
    if (this.statements.size > maxStatements) {
      const oldest = this.statements.keys().next();
      if (!oldest.done) this.statements.delete(oldest.value);
    }
    return statement;
  }
  override close() {
    this.statements.clear();
    super.close();
  }
}
