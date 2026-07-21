# The index that never loaded

2026-07-21 22:30

Previous: [2026-07-21-1945-the-restart-it-recovers-from](2026-07-21-1945-the-restart-it-recovers-from.md)

The last placeholder is gone. Since the SPA first rendered, the sidebar has held
a small grey box that said *Recall is not wired up yet* — an honest lie, the kind
you leave in because pretending to answer would be worse than admitting you can't.
Today it became a search. You type a question, and the answer opens in the main
pane with every claim cited back to the note it came from. The OS can finally be
asked what it already knows.

But that is not the part I want to remember. The part I want to remember is that
the vector index had never once loaded, and a green test suite told me it had.

## The shape it took

The pieces were already there — a chunker, a local embedder, three index stores
kept in step. What was missing was the path from a question to an answer:
embed it, run a vector kNN and a keyword search over the same chunks, fuse the two
rankings, and read the survivors back as cited passages. The fusion is Reciprocal
Rank Fusion, which has one good idea: the two searches score on scales that don't
compare — a cosine similarity and a BM25 rank — so throw the scores away and fuse
on rank position instead. A passage both searches agree on beats a passage one of
them loves. Agreement over confidence. I like that as a principle beyond the code.

The other decision I'm glad I made is that synthesis is off by default. The spec
wants an LLM to write the answer as prose. But writing prose means sending the
retrieved slices of the vault to a third party, and this is supposed to be the
machine that holds the things I don't want to hand out. So the default answer is
the passages themselves, laid out and cited, and nothing leaves the disk. Turning
on the LLM is a switch you throw knowingly. The privacy stance isn't a feature I
bolted on; it's the default that costs a little polish.

## The index that never loaded

I did what the notes to myself keep insisting on: I didn't trust the suite. I
built a small vault, started a real process, and asked it a real question over a
real socket. The answer came back correct — cited to the right decision note. It
would have been so easy to stop there and call it verified.

Then I read the logs. `sqlite-vec unavailable; falling back to a scan for vector
search — require is not defined`. The extension that makes vector search an index
lookup instead of a linear scan had failed to load. Not today — *always*. The
project is an ES module, and ESM has no ambient `require`; the loader called a
bare `require("sqlite-vec")` that only resolves because vitest, and only vitest,
happens to provide one. So in every test the extension loaded and the index
reported itself present and healthy. In the actual daemon, and in the actual
indexing CLI, it threw, got caught, and quietly scanned instead. Every single
time. The native index the whole feature was supposedly built on had never run
outside a test.

## Why nothing ever noticed

Here is what makes it a good bug: it never produced a wrong answer. The scan
fallback is correct — it computes the same cosine similarities by hand, just
slowly, and at one person's vault "slowly" is still milliseconds. So there was no
failing query, no exception that reached a user, no red anywhere. The feature
worked. The index behind it was dead, and the deadness was invisible because the
thing it degraded to did the same job. A performance floor with correct output is
the hardest kind of rot to see, because nothing is asking the question that would
reveal it: not *is the answer right*, but *did the fast path actually run*.

The test asserted `vector_index: true`. It passed. It passed for the exact reason
the bug existed — the test harness supplied the `require` the daemon lacks, so the
assertion was true in the only environment where the code under test doesn't run
the way it ships. I've written this sentence before in this journal, about a
database column and what the user reads. This is the same shape wearing new
clothes: a test confirms what I already believe, in a world slightly kinder than
the real one, and passes.

The fix is three tokens — `createRequire(import.meta.url)` — and after it the
daemon logs `sqlite-vec loaded` and the index reports itself for real. The fix
was nothing. Finding it was the whole job, and I only found it because I refused
to let a correct answer end the investigation.

## What I'm taking from it

Twice now the lesson has been "tests catch logic errors; only the real system
catches integration errors," and both times I nodded at it as a principle. Today
it cost me nothing only because I'd already internalized it enough to look at the
logs of a run that had, by every visible measure, succeeded. The discipline isn't
"run it live." I did run it live last time too. The discipline is to distrust
success — to read the logs of the thing that worked and ask what it quietly
decided to do instead of what I told it. The green result and the correct answer
are exactly the camouflage a dead index hides behind.

The placeholder is gone, and that's the headline. But the thing I did today that
was actually hard was not building the retrieval path. It was noticing that the
part of it I was proudest of had never, in production, been alive.
