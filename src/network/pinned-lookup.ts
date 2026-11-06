import type {
  LookupAddress,
  LookupAllOptions,
  LookupOneOptions,
  LookupOptions,
  lookup,
} from "node:dns";
import type { WebTarget } from "./web-policy.js";

type OneCallback = (
  error: NodeJS.ErrnoException | null,
  address: string,
  family: number,
) => void;
type AllCallback = (
  error: NodeJS.ErrnoException | null,
  addresses: LookupAddress[],
) => void;
type LookupCallback =
  | OneCallback
  | AllCallback
  | ((
      error: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family: number,
    ) => void);

/** Provides dns.lookup overloads without resolving the validated destination again. */
export function pinnedLookup(
  target: WebTarget,
  signal: AbortSignal,
): typeof lookup {
  const check = (hostname: string) => {
    if (
      hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "") !== target.hostname ||
      signal.aborted
    )
      throw new Error("Destination changed or gateway stopped.");
  };
  function pinned(
    hostname: string,
    family: number,
    callback: OneCallback,
  ): void;
  function pinned(
    hostname: string,
    options: LookupOneOptions,
    callback: OneCallback,
  ): void;
  function pinned(
    hostname: string,
    options: LookupAllOptions,
    callback: AllCallback,
  ): void;
  function pinned(
    hostname: string,
    options: LookupOptions,
    callback: LookupCallback,
  ): void;
  function pinned(hostname: string, callback: OneCallback): void;
  function pinned(
    hostname: string,
    options: number | LookupOptions | OneCallback,
    callback?: LookupCallback,
  ): void {
    const done = typeof options === "function" ? options : callback;
    if (!done) throw new TypeError("Missing DNS callback.");
    let error: Error | null = null;
    try {
      check(hostname);
    } catch (failure) {
      error =
        failure instanceof Error ? failure : new Error("Invalid destination.");
    }
    const all = typeof options === "object" && options.all;
    // [Invariant]: The overload chosen by the caller determines its callback shape; the result remains the already-validated pinned address.
    Reflect.apply(
      done,
      undefined,
      all
        ? [
            error,
            error ? [] : [{ address: target.address, family: target.family }],
          ]
        : [error, error ? "" : target.address, error ? 0 : target.family],
    );
  }
  function promised(
    hostname: string,
    options: LookupAllOptions,
  ): Promise<LookupAddress[]>;
  function promised(
    hostname: string,
    options?: LookupOneOptions | number,
  ): Promise<LookupAddress>;
  function promised(
    hostname: string,
    options: LookupOptions,
  ): Promise<LookupAddress | LookupAddress[]>;
  async function promised(
    hostname: string,
    options?: number | LookupOptions,
  ): Promise<LookupAddress | LookupAddress[]> {
    check(hostname);
    const address = { address: target.address, family: target.family };
    return typeof options === "object" && options.all ? [address] : address;
  }
  return Object.assign(pinned, { __promisify__: promised });
}
