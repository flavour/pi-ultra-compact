/**
 * Native checkpoint awareness for the pruning pass.
 *
 * Some providers compact the transcript themselves and return an opaque
 * encrypted checkpoint instead of a text summary. OpenAI Codex does this, and
 * extensions such as pi-codex-compaction store that checkpoint in Pi's
 * compaction entry.
 *
 * The provider replays the checkpoint in place of the entries it replaced, and
 * refuses any request where a context edit touches history the checkpoint still
 * retains: an opaque blob cannot be rewritten, so the edit is treated as
 * corruption and the request is aborted. Editing that history would buy nothing
 * (the provider never receives it) and would break the session outright.
 *
 * This module resolves which projected entries sit inside that protected block
 * so the pruning pass can leave them alone.
 */

/** `details.kind` written by pi-codex-compaction on its compaction entries. */
export const NATIVE_COMPACTION_KIND = "openai-codex-native-compaction";

interface NativeCheckpoint {
	/** Position of the checkpoint entry in the projection. */
	index: number;
	/** Pi id of the checkpoint entry; post-checkpoint entries descend from it. */
	entryId: string;
}

interface ModelIdentity {
	provider?: unknown;
	api?: unknown;
	id?: unknown;
	name?: unknown;
	model?: unknown;
}

/** Same shape pi-codex-compaction writes into `details.modelKey`. */
function checkpointModelKey(model: ModelIdentity | undefined): string | undefined {
	if (!model) return undefined;
	const id = model.id ?? model.name ?? model.model;
	if (
		typeof model.provider !== "string" ||
		typeof model.api !== "string" ||
		typeof id !== "string"
	) {
		return undefined;
	}
	return `${model.provider}:${model.api}:${id}`;
}

/**
 * The newest compaction entry in the projection, if it carries a native
 * checkpoint for this model.
 *
 * Pi keeps only the newest compaction on the active path, so scanning back from
 * the end of the projection finds the same entry the provider would. A compaction
 * whose details are not a native checkpoint means a text summary stands: nothing
 * is opaque, nothing is protected.
 */
function findNativeCheckpoint(
	entries: readonly { sourceEntry?: { id?: string; type?: string; details?: unknown } }[],
	model: ModelIdentity | undefined,
): NativeCheckpoint | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const source = entries[index]?.sourceEntry;
		if (source?.type !== "compaction") continue;

		const details = source.details as { kind?: unknown; modelKey?: unknown } | undefined;
		if (details?.kind !== NATIVE_COMPACTION_KIND || typeof details.modelKey !== "string") {
			return undefined;
		}

		// A checkpoint from another model is already fatal for that provider and
		// invisible to this one; a local model receives the retained entries, so
		// pruning them stays both useful and safe.
		const key = checkpointModelKey(model);
		if (!key || key !== details.modelKey) return undefined;

		if (typeof source.id !== "string") return undefined;
		return { index, entryId: source.id };
	}
	return undefined;
}

/**
 * Ids the pruning pass must not edit.
 *
 * Pi projects a checkpointing session as: the compaction entry, then the entries
 * the checkpoint still retains from *before* it, then everything appended after
 * it. Only that last block is the provider's own new context, and only editing
 * entries inside it is safe. The retained block is bounded by the first entry
 * whose parent is the checkpoint entry.
 *
 * Returns an empty set when nothing is checkpointed, so callers can pass the
 * result straight through.
 */
export function resolveNativeProtectedIds(
	entries: readonly {
		sourceEntry?: { id?: string; type?: string; details?: unknown; parentId?: string | null };
	}[],
	model: ModelIdentity | undefined,
): Set<string> {
	const checkpoint = findNativeCheckpoint(entries, model);
	if (!checkpoint) return new Set();

	// Entries appended after the checkpoint descend from it. Everything the
	// projection holds before that point contributes to the checkpointed
	// history, including the entries the checkpoint kept verbatim.
	//
	// The compaction entry's own `firstKeptEntryId` is not used to find that
	// boundary: it names where the retained block starts, which is the first
	// entry after the checkpoint in the projection, so it cannot separate the
	// retained block from the work done since. Parent links can.
	let boundary = -1;
	for (let index = checkpoint.index + 1; index < entries.length; index++) {
		if (entries[index]?.sourceEntry?.parentId === checkpoint.entryId) {
			boundary = index;
			break;
		}
	}

	// Nothing descends from the checkpoint: the projection holds only checkpointed
	// history, so there is nothing safe to prune.
	const protectedIds = new Set<string>();
	const end = boundary >= 0 ? boundary : entries.length;
	for (let index = 0; index < end; index++) {
		const id = entries[index]?.sourceEntry?.id;
		if (typeof id === "string") protectedIds.add(id);
	}
	return protectedIds;
}
