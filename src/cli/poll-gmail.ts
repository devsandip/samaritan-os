#!/usr/bin/env node
/**
 * `samaritan poll-gmail` (TECH-SPEC §2.2, §12 step 18).
 *
 * One manual poll of the Gmail listener, for setting it up and for the live
 * check no unit test can stand in for: does a real inbox, through the real
 * source, actually reach the Action Center? The daemon runs this same loop on a
 * timer; this is the one-shot you run once by hand to confirm the token works
 * and see what comes back.
 *
 *   pnpm poll-gmail            # one poll, advancing the shared checkpoint
 *   pnpm poll-gmail --dry-run  # one poll, but do not move the checkpoint
 *
 * Unlike the daemon it ignores config's `enabled` flag — invoking it is the
 * consent — but it still needs the token in the Keychain (`gmail:<account>`).
 * It shares the daemon's durable checkpoint, so a message it pulls is one the
 * daemon then skips; the bus dedup makes that safe either way. Exit codes: 0
 * polled, 1 no token configured or the poll failed.
 */
import { createApp } from "../app.js";
import { GmailPoller, MemoryCheckpoint, type PollCheckpoint } from "../events/listeners/gmail-poll.js";
import { createGmailSource } from "../events/listeners/gmail-source.js";
import { StoreCheckpoint } from "../store/poll-state.js";

const dryRun = process.argv.slice(2).includes("--dry-run");
const app = createApp();

try {
  const gmail = app.config.gmail;
  const source = createGmailSource({
    account: gmail.account,
    query: gmail.query,
    backfillDays: gmail.backfill_days,
    maxPerPoll: gmail.max_per_poll,
  });

  if (!source) {
    console.error(
      `No Gmail token for "${gmail.account}". Add one (read + compose scope) with:\n` +
        `  security add-generic-password -s samaritan -a gmail:${gmail.account} -w`,
    );
    process.exit(1);
  }

  const checkpoint: PollCheckpoint = dryRun ? new MemoryCheckpoint() : new StoreCheckpoint(app.db, "gmail");
  if (dryRun) checkpoint.save(new StoreCheckpoint(app.db, "gmail").load()); // start from the real mark, don't persist

  let published = 0;
  let deduped = 0;
  const dispatched = new Set<string>();
  const poller = new GmailPoller({
    source,
    checkpoint,
    publish: async (event) => {
      const result = await app.eventBus.publish(event);
      published++;
      if (result.deduped) deduped++;
      for (const id of result.dispatched) dispatched.add(id);
      return result;
    },
  });

  await poller.poll();

  const targets = dispatched.size ? [...dispatched].join(", ") : "nobody (no subscriber matched)";
  console.log(
    `Polled gmail:${gmail.account} (${gmail.query}). ` +
      `${published} message(s), ${deduped} already seen; dispatched to ${targets}.` +
      (dryRun ? " Checkpoint left untouched (--dry-run)." : ""),
  );
} catch (err) {
  console.error(`Gmail poll failed: ${(err as Error).message}`);
  process.exit(1);
} finally {
  app.close();
}
