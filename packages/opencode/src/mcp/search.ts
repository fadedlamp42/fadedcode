import type { ConfigMCP } from "@/config/mcp"

/**
 * Retrieval over the MCP catalogue for the agent-facing `mcp` tool.
 *
 * Two-stage ranking in the spirit of MCP-Zero / Tool-to-Agent Retrieval: tool and facet hits roll
 * up to their server, and the hand-written advertisement text outweighs tool descriptions (which a
 * remote server controls). BM25-ish lexical scoring plus a cheap fuzzy match on server names; at
 * ~40 servers / ~900 tools nothing heavier is warranted.
 */

export interface CatalogTool {
  name: string
  description: string
}

export interface CatalogEntry {
  name: string
  status: string
  pinned?: ConfigMCP.Pinned
  exposure?: ConfigMCP.ExposureEntry
  summary: string
  advertisementSource: "advertisement" | "instructions" | "derived"
  facets: Record<string, string>
  toolCount: number
  estimatedTokens: number
  tools: CatalogTool[]
}

export interface SearchHit {
  /** ready-made `show` target: `server` or `server:prefix` */
  target: string
  server: string
  status: string
  score: number
  summary: string
  toolCount: number
  estimatedTokens: number
  matchedTools: CatalogTool[]
}

const FIELD_WEIGHTS = {
  name: 5,
  summary: 4,
  facet: 4,
  toolName: 2,
  toolDescription: 1,
}

export function search(query: string, catalog: CatalogEntry[], limit = 5): SearchHit[] {
  const terms = tokenize(query)
  if (terms.length === 0) return []

  const idf = inverseDocumentFrequency(terms, catalog)
  const hits: SearchHit[] = []

  for (const entry of catalog) {
    hits.push(scoreServer(terms, idf, entry))
    for (const [prefix, description] of Object.entries(entry.facets)) {
      hits.push(scoreFacet(terms, idf, entry, prefix, description))
    }
  }

  return hits
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

function scoreServer(terms: string[], idf: Map<string, number>, entry: CatalogEntry): SearchHit {
  // facets are ranked as their own documents, so the server doc deliberately excludes facet text:
  // a query that lands squarely on one facet should surface `server:prefix`, not the whole server
  let score = 0
  score += FIELD_WEIGHTS.name * overlap(terms, idf, tokenize(entry.name))
  score += FIELD_WEIGHTS.name * fuzzyNameBonus(terms, entry.name)
  score += FIELD_WEIGHTS.summary * overlap(terms, idf, tokenize(entry.summary))
  const matchedTools = matchTools(terms, entry.tools)
  score += toolScore(terms, idf, matchedTools)
  return {
    target: entry.name,
    server: entry.name,
    status: entry.status,
    score,
    summary: entry.summary,
    toolCount: entry.toolCount,
    estimatedTokens: entry.estimatedTokens,
    matchedTools: matchedTools.slice(0, 5),
  }
}

function scoreFacet(
  terms: string[],
  idf: Map<string, number>,
  entry: CatalogEntry,
  prefix: string,
  description: string,
): SearchHit {
  const facetTools = entry.tools.filter((tool) =>
    prefix.split("|").some((alternative) => alternative.length > 0 && tool.name.startsWith(alternative)),
  )
  let score = 0
  score += FIELD_WEIGHTS.facet * overlap(terms, idf, tokenize(prefix + " " + description))
  const matchedTools = matchTools(terms, facetTools)
  score += toolScore(terms, idf, matchedTools)
  return {
    target: `${entry.name}:${prefix}`,
    server: entry.name,
    status: entry.status,
    score,
    summary: description,
    toolCount: facetTools.length,
    estimatedTokens: Math.round((entry.estimatedTokens * facetTools.length) / Math.max(entry.toolCount, 1)),
    matchedTools: matchedTools.slice(0, 5),
  }
}

function matchTools(terms: string[], tools: CatalogTool[]): CatalogTool[] {
  return tools
    .map((tool) => ({
      tool,
      hits: 2 * countOverlap(terms, tokenize(tool.name)) + countOverlap(terms, tokenize(firstLine(tool.description))),
    }))
    .filter((scored) => scored.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .map((scored) => scored.tool)
}

function toolScore(terms: string[], idf: Map<string, number>, matched: CatalogTool[]): number {
  let score = 0
  for (const tool of matched.slice(0, 10)) {
    score += FIELD_WEIGHTS.toolName * overlap(terms, idf, tokenize(tool.name))
    score += FIELD_WEIGHTS.toolDescription * overlap(terms, idf, tokenize(firstLine(tool.description)))
  }
  return score
}

/** idf over server-level documents so ubiquitous words ("get", "list") stop dominating. */
function inverseDocumentFrequency(terms: string[], catalog: CatalogEntry[]): Map<string, number> {
  const documentCount = Math.max(catalog.length, 1)
  const idf = new Map<string, number>()
  for (const term of terms) {
    let containing = 0
    for (const entry of catalog) {
      const text = [
        entry.name,
        entry.summary,
        ...Object.entries(entry.facets).flat(),
        ...entry.tools.map((tool) => tool.name + " " + firstLine(tool.description)),
      ].join(" ")
      if (tokenize(text).includes(term)) containing++
    }
    idf.set(term, Math.log(1 + (documentCount - containing + 0.5) / (containing + 0.5)))
  }
  return idf
}

function overlap(terms: string[], idf: Map<string, number>, docTokens: string[]): number {
  const docSet = new Set(docTokens)
  let score = 0
  for (const term of terms) {
    if (docSet.has(term)) score += idf.get(term) ?? 1
  }
  return score
}

function countOverlap(terms: string[], docTokens: string[]): number {
  const docSet = new Set(docTokens)
  return terms.filter((term) => docSet.has(term)).length
}

/** substring or subsequence of the server name, so "pg" still finds postgres-*. */
function fuzzyNameBonus(terms: string[], name: string): number {
  const lower = name.toLowerCase()
  let bonus = 0
  for (const term of terms) {
    if (lower.includes(term)) bonus += 1
    if (!lower.includes(term) && isSubsequence(term, lower)) bonus += 0.25
  }
  return bonus
}

function isSubsequence(needle: string, haystack: string): boolean {
  let index = 0
  for (const char of haystack) {
    if (char === needle[index]) index++
    if (index === needle.length) return true
  }
  return needle.length > 0 && index === needle.length
}

function firstLine(text: string): string {
  const newline = text.indexOf("\n")
  return newline === -1 ? text : text.slice(0, newline)
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1)
    .map(stem)
}

/** crude plural folding; applied to both query and documents, so consistency is what matters. */
function stem(token: string): string {
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1)
  return token
}

export * as McpSearch from "./search"
