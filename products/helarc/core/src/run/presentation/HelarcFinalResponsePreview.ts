import { JSONParser } from "@streamparser/json";
import { boundedPresentationText } from "./HelarcRunPresentation.js";

/** Only a display projection. Complete-turn interpretation owns validity and ending intent. */
export class HelarcFinalResponsePreview {
  private parser: JSONParser | null = new JSONParser({
    paths: ["$.response"], emitPartialTokens: true, emitPartialValues: true, keepStack: false,
  });
  private bytes = 0;
  private trailingSurrogate = "";
  private value = {text: "", omittedBytes: 0};
  private completedValues = 0;

  constructor() {
    this.parser!.onValue = ({value, key, stack, partial}) => {
      if (!this.parser) return;
      if (key !== "response" || stack.length !== 1 || typeof value !== "string") return;
      if (!partial && ++this.completedValues > 1) { this.discard(); return; }
      this.value = boundedPresentationText(value);
    };
    this.parser!.onError = () => this.discard();
  }

  write(delta: string): Readonly<{text: string; omittedBytes: number}> {
    if (!this.parser) return this.value;
    let text = this.trailingSurrogate + delta;
    this.trailingSurrogate = "";
    const last = text.charCodeAt(text.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
      this.trailingSurrogate = text.slice(-1);
      text = text.slice(0, -1);
    }
    this.bytes += new TextEncoder().encode(text).length;
    if (this.bytes > 128 * 1024) { this.parser = null; return this.value; }
    try { this.parser.write(text); } catch { this.discard(); }
    return this.value;
  }

  private discard(): void {
    this.parser = null;
    this.value = {text: "", omittedBytes: 0};
  }
}
