export class SendError extends Error {
  constructor(message: string, public code: string, public status: number = 400) {
    super(message);
    this.name = "SendError";
  }
}
