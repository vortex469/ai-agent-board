import { MAX_DESCRIPTION_LENGTH, MAX_TITLE_LENGTH } from '@ai-agent-board/shared/constants.js';

export interface RoadmapProposedTask {
  order: number;
  title: string;
  description: string;
  sourceText: string;
}

export interface RoadmapParseResult {
  tasks: RoadmapProposedTask[];
}

export const ROADMAP_TEXT_LIMIT = 20_000;
export const ROADMAP_TASK_LIMIT = 25;

type ParsedBlock = {
  titleSeed: string;
  sourceText: string;
  version?: string;
};

const VERSION_HEADING_RE = /^\s{0,3}(?:#{1,6}\s*)?(?:\*\*)?((?:v|version)\s*\d+(?:\.\d+){0,3}(?:[-._]?[a-z0-9]+)?)(?:\*\*)?(?:\s*(?:[-:]|\u2013|\u2014)\s*(.+))?\s*$/i;
const ITEM_RE = /^\s*(?:[-*+]\s+|\d{1,3}[.)]\s+|\[[ xX]\]\s+)(.+?)\s*$/;
const CHECKBOX_ITEM_RE = /^\s*[-*+]\s+\[[ xX]\]\s+(.+?)\s*$/;

export function parseRoadmapText(input: unknown): RoadmapParseResult | string {
  if (typeof input !== 'string') return 'Roadmap text is required';
  const text = input.replace(/\r\n?/g, '\n').trim();
  if (!text) return 'Paste roadmap text before previewing';
  if (text.length > ROADMAP_TEXT_LIMIT) return `Roadmap text must be at most ${ROADMAP_TEXT_LIMIT.toLocaleString()} characters`;

  const lines = text.split('\n');
  const versionBlocks = parseVersionBlocks(lines);
  const listBlocks = versionBlocks.length > 0 ? [] : parseListBlocks(lines);
  const blocks = versionBlocks.length > 0 ? versionBlocks : listBlocks.length > 0 ? listBlocks : parsePlainTextBlock(lines);

  if (blocks.length === 0) {
    return 'Could not find clear task boundaries. Use version headings, bullets, or numbered items.';
  }
  if (blocks.length > ROADMAP_TASK_LIMIT) {
    return `Roadmap intake supports up to ${ROADMAP_TASK_LIMIT} cards at a time`;
  }

  const tasks = blocks.map((block, index) => {
    const rawTitle = block.version
      ? block.titleSeed && normalizeWhitespace(block.titleSeed).toLowerCase() !== block.version.toLowerCase()
        ? `${normalizeWhitespace(block.version)}: ${block.titleSeed}`
        : normalizeWhitespace(block.version)
      : block.titleSeed;
    const title = makeTitle(rawTitle, index + 1);
    const sourceText = clamp(block.sourceText.trim(), MAX_DESCRIPTION_LENGTH - 24);
    return {
      order: index + 1,
      title,
      description: `Source roadmap item:\n\n${sourceText}`,
      sourceText,
    };
  });

  return { tasks };
}

function parseVersionBlocks(lines: string[]): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  let current: { version: string; titleSeed: string; lines: string[] } | null = null;

  for (const rawLine of lines) {
    const match = rawLine.match(VERSION_HEADING_RE);
    if (match) {
      if (current) blocks.push(finishVersionBlock(current));
      const version = normalizeWhitespace(match[1]);
      const inline = normalizeWhitespace(match[2] ?? '');
      current = { version, titleSeed: inline || version, lines: [rawLine.trim()] };
      continue;
    }
    if (current) current.lines.push(rawLine);
  }

  if (current) blocks.push(finishVersionBlock(current));
  return blocks.filter((block) => block.sourceText.trim().length > 0);
}

function finishVersionBlock(block: { version: string; titleSeed: string; lines: string[] }): ParsedBlock {
  const firstNestedItem = block.lines
    .slice(1)
    .map((line) => parseItemLine(line))
    .find((line): line is string => !!line);
  return {
    version: block.version,
    titleSeed: block.titleSeed === block.version && firstNestedItem ? firstNestedItem : block.titleSeed,
    sourceText: trimBlankEdges(block.lines).join('\n'),
  };
}

function parseListBlocks(lines: string[]): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  let current: { titleSeed: string; lines: string[] } | null = null;

  for (const rawLine of lines) {
    const item = parseItemLine(rawLine);
    if (item) {
      if (current) blocks.push({ titleSeed: current.titleSeed, sourceText: trimBlankEdges(current.lines).join('\n') });
      current = { titleSeed: item, lines: [rawLine.trim()] };
      continue;
    }

    if (current) {
      if (!rawLine.trim()) {
        current.lines.push(rawLine);
      } else {
        current.lines.push(rawLine);
      }
    }
  }

  if (current) blocks.push({ titleSeed: current.titleSeed, sourceText: trimBlankEdges(current.lines).join('\n') });
  return blocks.filter((block) => block.sourceText.trim().length > 0);
}

function parsePlainTextBlock(lines: string[]): ParsedBlock[] {
  const trimmedLines = trimBlankEdges(lines);
  const meaningfulLines = trimmedLines.filter((line) => line.trim());
  if (meaningfulLines.length !== 1) return [];

  const sourceText = meaningfulLines[0].trim();
  return [{ titleSeed: sourceText, sourceText }];
}

function parseItemLine(line: string): string | null {
  const checkbox = line.match(CHECKBOX_ITEM_RE);
  const match = checkbox ?? line.match(ITEM_RE);
  if (!match) return null;
  return normalizeWhitespace(match[1]);
}

function makeTitle(raw: string, order: number): string {
  const cleaned = normalizeWhitespace(raw)
    .replace(/^#+\s*/, '')
    .replace(/\*\*/g, '')
    .replace(/[`*_~]/g, '')
    .replace(/\s+#\d+$/g, '');
  const beforeColon = cleaned.match(/^(.{8,80}?):\s+\S/);
  const titleText = beforeColon ? beforeColon[1] : cleaned;
  const numbered = `${String(order).padStart(2, '0')}. ${clamp(titleText, MAX_TITLE_LENGTH - 4)}`;
  return clamp(numbered, MAX_TITLE_LENGTH);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start += 1;
  while (end > start && !lines[end - 1].trim()) end -= 1;
  return lines.slice(start, end);
}

function clamp(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}
