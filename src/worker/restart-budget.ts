export class RestartBudget {
  private crashes: number[] = [];
  nextDelay(now: number) {
    this.crashes = this.crashes.filter((time) => now - time < 5 * 60 * 1000);
    if (this.crashes.length >= 5) return null;
    const wait = 500 * 2 ** this.crashes.length;
    this.crashes.push(now);
    return wait;
  }
}
