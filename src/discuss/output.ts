import { createTranscript, title, type TranscriptOptions } from "../output.js";
import type { DiscussUI } from "./run.js";
import type { DiscussEntry, Side } from "./store.js";

const SIDE_COLOR: Record<Side, number> = { author: 36, critic: 35 };
const MODE = { propose: "proposal", draft: "blind draft", verdict: "verdict" } as const;

/** Discussion transcript: each Turn's progress, then the entry it committed. */
export function createDiscussOutput(options: TranscriptOptions = {}): DiscussUI {
  const transcript = createTranscript(options);
  const { symbols } = transcript;
  const note = (text: string | undefined) => {
    if (text?.trim()) transcript.lines(text.trim());
  };

  return {
    startTurn({ side, participant, round, mode, retry }) {
      transcript.startTurn(
        `Round ${round} · ${title(side)} · ${participant.harness}:${participant.model} · ${MODE[mode]}${retry ? " (retry)" : ""}`,
        SIDE_COLOR[side]
      );
    },
    event: transcript.event,
    entry(entry: DiscussEntry) {
      if (entry.kind === "followup") {
        transcript.startTurn("Follow-up · Caller → Author", 34);
        note(entry.body);
        return;
      }
      if (entry.kind === "failure") {
        note(entry.body);
        transcript.end(`${symbols.fail} ${title(entry.role ?? "relay")} Turn failed`, 31);
        return;
      }
      if (entry.kind === "verdict") {
        note(`Strongest objection: ${entry.objection}`);
        note(entry.body);
        if (entry.verdict === "agree")
          transcript.end(`${symbols.ok} Agreed on proposal v${entry.version}`, 32);
        else transcript.end(`${symbols.start} Revise proposal v${entry.version}`, 33);
        return;
      }
      note(entry.body);
      transcript.end(
        entry.kind === "draft"
          ? `${symbols.start} Blind draft · Critic`
          : `${symbols.start} Proposal v${entry.version} · Author → Critic`,
        33
      );
    },
  };
}
