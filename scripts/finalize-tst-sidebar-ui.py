from pathlib import Path


def replace(path, old, new):
    target = Path(path)
    text = target.read_text()
    if old not in text:
        raise SystemExit(f"missing patch anchor in {path}: {old[:100]!r}")
    target.write_text(text.replace(old, new, 1))


# Remove the last ambiguous command-result fallback from the chat surface.
replace(
    "src/renderer/react/ChatPane.tsx",
    "  if (value == null) return 'Completed.';",
    "  if (value == null) return 'Command completed.';",
)
replace(
    "src/renderer/react/ChatPane.tsx",
    "    return 'Completed.';",
    "    return 'Command completed.';",
)

# Keep the preload contract typed; the sidebar should not need a broad any cast.
replace(
    "src/renderer/types.ts",
    "    memoryQuery: (sessionId: string, query: any) => Promise<any>;",
    "    memoryQuery: (sessionId: string, query: any) => Promise<any>;\n    memoryGraph: (sessionId: string) => Promise<{\n      available?: boolean;\n      reason?: string;\n      root?: string;\n      graph?: { files?: number; modules?: number; symbols?: number; edges?: number; progress?: { discovered?: number; indexed?: number; skipped?: number; complete?: boolean } };\n      files?: string[];\n      editedFiles?: Array<{ path: string; tool?: string; updatedAt?: number; mutationId?: string | null; executionId?: string | null }>;\n    }>;",
)
replace(
    "src/renderer/react/TstMemorySidebar.tsx",
    "      const api = window.cuppet as any;\n      const graph = await api.cognitive.memoryGraph(sessionId).catch((error: unknown) => ({ available: false, reason: cleanError(error), files: [], editedFiles: [] }));",
    "      const graph = await window.cuppet.cognitive.memoryGraph(sessionId).catch((error: unknown) => ({ available: false, reason: cleanError(error), files: [], editedFiles: [] }));",
)
