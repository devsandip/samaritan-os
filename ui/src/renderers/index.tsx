/**
 * Layout dispatch (UI-SPEC §4.2).
 *
 * The whole pluggability claim at the UI layer reduces to this table: a new
 * capability picks one of four `layout` values in its manifest and gets a
 * rendered surface with no frontend change. Nothing here knows the name of any
 * capability, and an unknown layout resolves to the §4.7 raw fallback rather
 * than throwing.
 */
import type { ReactNode } from "react";
import type { RenderLayout } from "../api/types";
import { CardRenderer } from "./CardRenderer";
import { DiffRenderer } from "./DiffRenderer";
import { DocumentRenderer } from "./DocumentRenderer";
import { FormRenderer } from "./FormRenderer";
import { RawRenderer } from "./RawRenderer";
import type { RendererProps } from "./types";

const RENDERERS: Record<RenderLayout | "raw", (props: RendererProps) => ReactNode> = {
  card: CardRenderer,
  form: FormRenderer,
  document: DocumentRenderer,
  diff: DiffRenderer,
  raw: RawRenderer,
};

export function ItemBody({
  layout,
  ...props
}: RendererProps & { layout: RenderLayout | "raw" }) {
  const Renderer = RENDERERS[layout] ?? RawRenderer;
  return <Renderer {...props} />;
}

export { CardRenderer, DocumentRenderer, DiffRenderer, FormRenderer, RawRenderer };
export type { RendererProps };
