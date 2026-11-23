// Web Serial transport. Owns the port, keeps reading through recoverable stream errors
// (Chrome raises BreakError/ParityError on glitches and ends only the current ReadableStream),
// and exposes a write() for outgoing frames.

const recoverableErrors = new Set(["BreakError", "ParityError", "FramingError", "BufferOverrunError"]);

export type SerialLinkEvents = {
  data: (bytes: Uint8Array) => void;
  log: (message: string) => void;
  /** a recoverable read error happened and reading resumed */
  recovered: (errorName: string, message: string) => void;
  /** the port is closed; reason is set when it was not a user disconnect */
  closed: (reason?: string) => void;
};

export class SerialLink {
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private active = false;
  private readTask: Promise<void> | null = null;

  constructor(private readonly events: SerialLinkEvents) {}

  get connected(): boolean { return this.active; }

  /** USB vendor/product ids of the open port, when the browser exposes them. */
  get info(): { usbVendorId?: number; usbProductId?: number } | null {
    return this.port?.getInfo() ?? null;
  }

  static get available(): boolean { return typeof navigator !== "undefined" && "serial" in navigator; }

  /** Prompts for a port, opens it, and starts reading in the background. */
  async connect(baudRate: number): Promise<void> {
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate, bufferSize: 16384 });
    if (!port.readable || !port.writable) { await port.close(); throw new Error("Serial port did not provide readable and writable streams"); }
    this.port = port;
    this.writer = port.writable.getWriter();
    this.active = true;
    this.readTask = this.readLoop(port).catch(async (error: unknown) => {
      if (!this.active) return;
      const message = error instanceof Error ? error.message : String(error);
      await this.shutdown();
      this.events.closed(message);
    });
  }

  async disconnect(): Promise<void> {
    if (!this.active) return;
    await this.shutdown();
    this.events.closed();
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (!this.writer) throw new Error("Serial port is not open");
    await this.writer.write(bytes);
  }

  private async shutdown(): Promise<void> {
    this.active = false;
    try { await this.reader?.cancel(); } catch { /* stream already closed */ }
    try { this.writer?.releaseLock(); } catch { /* lock already gone */ }
    await this.readTask?.catch(() => undefined);
    try { await this.port?.close(); } catch (error) { this.events.log(`Close: ${String(error)}`); }
    this.port = null; this.reader = null; this.writer = null; this.readTask = null;
  }

  private async readLoop(port: SerialPort): Promise<void> {
    while (this.active) {
      if (!port.readable) throw new Error("Serial port lost its readable stream (device unplugged?)");
      const reader = port.readable.getReader();
      this.reader = reader;
      try {
        while (this.active) {
          const { value, done } = await reader.read();
          if (done) return;
          if (value) this.events.data(value);
        }
      } catch (error) {
        if (!this.active || !(error instanceof DOMException) || !recoverableErrors.has(error.name)) throw error;
        this.events.recovered(error.name, error.message);
      } finally {
        try { reader.releaseLock(); } catch { /* already released */ }
        if (this.reader === reader) this.reader = null;
      }
    }
  }
}
