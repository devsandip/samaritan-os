/**
 * Ask-Samaritan (UI-SPEC §3.2, TECH-SPEC §5.5, §7).
 *
 * The result page for a question typed into the sidebar box. It reads the
 * question from the route (so the page is addressable and survives a refresh),
 * asks the daemon, and renders the answer with its sources. Retrieval is always
 * local; whether the answer is prose or the passages themselves depends on the
 * `recall.synthesis` setting, and either way every claim carries a citation the
 * reader can open.
 *
 * A miss is not an error: the daemon returns a plain "couldn't find anything" and
 * no sources, which renders as an answer, not a failure.
 */
import { api } from "../api/client";
import type { RecallAnswer } from "../api/types";
import { EmptyState, ErrorBanner, SkeletonRows } from "../components/states";
import { useAsync } from "../lib/useAsync";

export function AskView({ question }: { question: string }) {
  const trimmed = question.trim();
  const result = useAsync(
    () => (trimmed ? api.recall(trimmed) : Promise.resolve(undefined)),
    [trimmed],
  );

  return (
    <div className="ask-view">
      <h1 className="h-greet">Ask Samaritan</h1>
      <p className="h-sub">
        Answered from your vault, journals and the decision trail — every claim cited, nothing
        leaves this machine unless you turned synthesis on.
      </p>

      {!trimmed ? (
        <EmptyState left>
          Type a question in the box on the left — try <em>“why did we pick node:sqlite?”</em> or{" "}
          <em>“what did I decide about the vendor?”</em>
        </EmptyState>
      ) : result.loading && !result.data ? (
        <div style={{ marginTop: 16 }}>
          <SkeletonRows count={3} />
        </div>
      ) : result.error ? (
        <ErrorBanner error={result.error} onRetry={result.reload} />
      ) : result.data ? (
        <Answer question={trimmed} answer={result.data} />
      ) : null}
    </div>
  );
}

function Answer({ question, answer }: { question: string; answer: RecallAnswer }) {
  return (
    <div className="answer">
      <div className="answer-q">“{question}”</div>
      <div className="answer-body">{answer.answer}</div>

      {answer.citations.length ? (
        <div className="sources">
          <div className="sources-h">
            {answer.citations.length} source{answer.citations.length === 1 ? "" : "s"} ·{" "}
            {answer.retrieval_path}
          </div>
          {answer.citations.map((citation, index) => (
            <div className="source" key={`${citation.ref}-${index}`}>
              <div className="source-head">
                <span className="source-kind">{citation.kind}</span>
                <span className="source-ref">{citation.ref}</span>
              </div>
              {citation.excerpt ? <div className="source-excerpt">{citation.excerpt}</div> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
