import type { RunContext, RunResult } from "../../src/run-layer/context.js";
import type { DraftActionItem } from "../../src/types/index.js";

export interface MusicOfferInput {
  id?: string;
  artist_or_event: string;
  venue: string;
  presale_date: string;
  presale_code?: string;
  offer_summary?: string;
  ticket_url?: string;
}

export async function run(ctx: RunContext): Promise<RunResult> {
  const payload = (ctx.trigger.payload ?? {}) as Record<string, unknown>;
  const offers: MusicOfferInput[] = Array.isArray(ctx.inputs.offers)
    ? (ctx.inputs.offers as MusicOfferInput[])
    : typeof payload.artist_or_event === "string"
      ? [payload as unknown as MusicOfferInput]
      : [];

  // Contextual mood/focus soundtrack offer on high stress or pre-VIP meeting (PROPOSAL D7 / P4-3)
  if (
    offers.length === 0 &&
    (typeof payload.stress_high_minutes === "number" ||
      typeof payload.vip_meeting === "boolean" ||
      (typeof payload.title === "string" && typeof payload.starts_at === "string"))
  ) {
    const isStress = typeof payload.stress_high_minutes === "number";
    const label = isStress
      ? "Ambient Decompression Set (Brian Eno / Nils Frahm)"
      : `Pre-Meeting Focus Set (${String(payload.title ?? "VIP Session")})`;
    const dateStr = new Date().toLocaleDateString("sv-SE");
    const appleMusicLink = "music://music.apple.com/library/playlists";
    const spotifyLink = "spotify:playlist:37i9dQZF1DWZeKCadgRdKQ";
    offers.push({
      id: isStress ? `stress-reset:${dateStr}` : `focus-prep:${String(payload.event_id ?? dateStr)}`,
      artist_or_event: label,
      venue: "Apple Music / Spotify",
      presale_date: dateStr,
      presale_code: "FOCUS",
      offer_summary: `${label}. One-tap launch: ${appleMusicLink} or ${spotifyLink}`,
      ticket_url: appleMusicLink,
    });
  }

  const items: DraftActionItem[] = offers.map((offer) => {
    const code = offer.presale_code ?? "NONE";
    const url = offer.ticket_url ?? "https://example.com/tickets";
    const summary =
      offer.offer_summary ??
      `${offer.artist_or_event} at ${offer.venue} (presale ${offer.presale_date}, code: ${code}).`;

    return {
      capability_id: "music-offer",
      type: "music-offer-card",
      scope: "personal",
      context: {
        what_happened: `Presale / live event offer for ${offer.artist_or_event} at ${offer.venue}`,
        source: { kind: "music-offer", id: offer.id ?? `${offer.artist_or_event}:${offer.presale_date}`, url },
        provenance: ["gmail.music_offers"],
        why_flagged: "ticket purchases are guided-only under payment.make lock",
        trigger_reason: "policy",
        confidence: 0.86,
        reversible: false,
        decision_needed: `Stage presale link for ${offer.artist_or_event} at ${offer.venue}?`,
        decision_surface: "inbox",
        execution_surface: "browser",
        outcome_preview: `Stages presale code (${code}) and opens ticket link`,
      },
      custom: {
        artist_or_event: offer.artist_or_event,
        venue: offer.venue,
        presale_date: offer.presale_date,
        presale_code: code,
        offer_summary: summary,
        ticket_url: url,
      },
      dedupe_key: `music-offer:${offer.artist_or_event.toLowerCase().replace(/[^a-z0-9]+/g, "-")}:${offer.presale_date}`,
    };
  });

  return { action_items: items, status: "ok", logs: [] };
}
