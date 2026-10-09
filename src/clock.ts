export interface ScheduledWait {
  promise: Promise<void>;
  cancel(): void;
}

export interface Clock {
  now(): Date;
  schedule(ms: number): ScheduledWait;
  sleep(ms: number): Promise<void>;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  schedule(ms: number): ScheduledWait {
    let timer: ReturnType<typeof setTimeout>;
    const promise = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        resolve();
      }, ms);
    });
    return {
      promise,
      cancel() {
        clearTimeout(timer!);
      },
    };
  }

  async sleep(ms: number): Promise<void> {
    await this.schedule(ms).promise;
  }
}

export class FakeClock implements Clock {
  private instant: number;
  private sequence = 0;
  private readonly waits: Array<{
    dueAt: number;
    order: number;
    resolve: () => void;
    cancelled: boolean;
  }> = [];

  constructor(startAt = "2026-01-01T00:00:00.000Z") {
    this.instant = Date.parse(startAt);
  }

  now(): Date {
    return new Date(this.instant);
  }

  get pendingWaits(): number {
    return this.waits.filter((wait) => !wait.cancelled).length;
  }

  schedule(ms: number): ScheduledWait {
    let resolveWait!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolveWait = resolve;
    });
    const wait = {
      dueAt: this.instant + Math.max(0, ms),
      order: this.sequence++,
      resolve: resolveWait,
      cancelled: false,
    };
    this.waits.push(wait);
    return {
      promise,
      cancel: () => {
        wait.cancelled = true;
      },
    };
  }

  async sleep(ms: number): Promise<void> {
    await this.schedule(ms).promise;
  }

  advanceBy(ms: number): void {
    const destination = this.instant + ms;
    if (ms < 0) throw new RangeError("Clock cannot move backwards");
    const due = this.waits
      .filter((wait) => !wait.cancelled && wait.dueAt <= destination)
      .sort((a, b) => a.dueAt - b.dueAt || a.order - b.order);
    for (const wait of due) {
      this.instant = wait.dueAt;
      wait.cancelled = true;
      wait.resolve();
    }
    this.instant = destination;
  }
}
