export interface MutationQueue {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

export class SerialMutationQueue implements MutationQueue {
  #tail: Promise<void> = Promise.resolve();
  #pending = 0;

  public constructor(private readonly maxPending = 32) {
    if (!Number.isInteger(maxPending) || maxPending < 1) {
      throw new TypeError("maxPending must be a positive integer");
    }
  }

  public run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#pending >= this.maxPending) {
      return Promise.reject(new Error("RMA_MIXING_BACKPRESSURE: REAPER mutation queue is full"));
    }
    this.#pending += 1;
    const execution = this.#tail.then(operation).finally(() => {
      this.#pending -= 1;
    });
    this.#tail = execution.then(() => undefined, () => undefined);
    return execution;
  }
}
