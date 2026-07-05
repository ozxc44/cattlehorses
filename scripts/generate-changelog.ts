#!/usr/bin/env ts-node
/**
 * Generate a CHANGELOG.md section from git history.
 *
 * Usage:
 *   ts-node scripts/generate-changelog.ts [since-tag-or-commit]
 *
 * If `since` is omitted, the full git history is used.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

export interface ParsedCommit {
  hash: string;
  type: string;
  scope?: string;
  breaking: boolean;
  subject: string;
  raw: string;
}

export interface GroupedCommits {
  [type: string]: ParsedCommit[];
}

const TYPE_HEADINGS: Record<string, string> = {
  feat: 'Features',
  fix: 'Bug Fixes',
  docs: 'Documentation',
  style: 'Styles',
  refactor: 'Code Refactoring',
  perf: 'Performance Improvements',
  test: 'Tests',
  build: 'Build System',
  ci: 'CI/CD',
  chore: 'Chores',
  revert: 'Reverts',
  other: 'Other',
};

const TYPE_ORDER = [
  'feat',
  'fix',
  'perf',
  'refactor',
  'docs',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
  'style',
  'other',
];

const CONVENTIONAL_COMMIT_RE = /^([a-zA-Z]+)(?:\(([^)]+)\))?(!)?\s?:\s*(.*)$/;
const ONELINE_RE = /^([0-9a-fA-F]+)\s+(.+)$/;

export function parseCommitLine(line: string): ParsedCommit {
  const onelineMatch = line.match(ONELINE_RE);
  if (!onelineMatch) {
    return {
      hash: '',
      type: 'other',
      breaking: false,
      subject: line.trim(),
      raw: line,
    };
  }

  const hash = onelineMatch[1];
  const rest = onelineMatch[2].trim();

  const conventionalMatch = rest.match(CONVENTIONAL_COMMIT_RE);
  if (conventionalMatch) {
    const type = conventionalMatch[1].toLowerCase();
    const scope = conventionalMatch[2] || undefined;
    const breaking = conventionalMatch[3] === '!';
    const subject = conventionalMatch[4].trim();
    return {
      hash,
      type: TYPE_HEADINGS[type] ? type : 'other',
      scope,
      breaking,
      subject,
      raw: line,
    };
  }

  return {
    hash,
    type: 'other',
    breaking: false,
    subject: rest,
    raw: line,
  };
}

export function groupCommits(commits: ParsedCommit[]): GroupedCommits {
  const groups: GroupedCommits = {};
  for (const commit of commits) {
    if (!groups[commit.type]) {
      groups[commit.type] = [];
    }
    groups[commit.type].push(commit);
  }
  return groups;
}

export function formatCommit(commit: ParsedCommit): string {
  const shortHash = commit.hash.slice(0, 7);
  let subject = commit.subject;
  if (commit.breaking) {
    subject = `**BREAKING:** ${subject}`;
  }
  if (commit.scope) {
    return `- **${commit.scope}**: ${subject} (${shortHash})`;
  }
  return `- ${subject} (${shortHash})`;
}

export function formatSection(groups: GroupedCommits): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push(`## [Unreleased] — ${today}`);
  lines.push('');

  for (const type of TYPE_ORDER) {
    const commits = groups[type];
    if (!commits || commits.length === 0) {
      continue;
    }

    const heading = TYPE_HEADINGS[type] ?? type;
    lines.push(`### ${heading}`);
    lines.push('');
    for (const commit of commits) {
      lines.push(formatCommit(commit));
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function updateChangelog(existing: string, section: string): string {
  if (!existing.trim()) {
    return `# Changelog\n\n${section}\n`;
  }

  const unreleasedRe = /^## \[Unreleased\].*$/m;
  const nextSectionRe = /^## \[/m;

  if (unreleasedRe.test(existing)) {
    // Replace the existing Unreleased block, preserving everything else.
    const startMatch = existing.match(unreleasedRe);
    if (!startMatch) {
      return `${existing.trim()}\n\n${section}\n`;
    }
    const start = startMatch.index!;
    const afterStart = existing.slice(start);
    const nextMatch = afterStart.slice(1).match(nextSectionRe);
    const end = nextMatch ? start + 1 + nextMatch.index! : existing.length;
    return existing.slice(0, start) + section + '\n' + existing.slice(end).replace(/^\n*/, '');
  }

  // Insert the new section right after the top-level title.
  const titleMatch = existing.match(/^# .*$/m);
  if (titleMatch) {
    const insertAfter = titleMatch.index! + titleMatch[0].length;
    return (
      existing.slice(0, insertAfter) +
      '\n\n' +
      section +
      '\n' +
      existing.slice(insertAfter).replace(/^\n*/, '')
    );
  }

  return `${existing.trim()}\n\n${section}\n`;
}

function findRepoRoot(): string {
  try {
    const root = execSync('git rev-parse --show-toplevel', {
      cwd: __dirname,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    return root;
  } catch (err) {
    console.error(`Failed to locate git repository root: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

function readGitLog(repoRoot: string, since?: string): string[] {
  const range = since ? `${since}..HEAD` : 'HEAD';
  // Use `git log --oneline` for the full history when no `since` is provided;
  // `HEAD` by itself would only return the latest commit.
  const command = since ? `git log --oneline ${range}` : 'git log --oneline';

  let output: string;
  try {
    output = execSync(command, { cwd: repoRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
  } catch (err) {
    console.error(`Failed to run git log. Is this a git repository? ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function main() {
  const repoRoot = findRepoRoot();
  const since = process.argv[2];
  const changelogPath = path.join(repoRoot, 'CHANGELOG.md');

  const lines = readGitLog(repoRoot, since);
  if (lines.length === 0) {
    console.log('No commits found; nothing to write.');
    return;
  }

  const commits = lines.map(parseCommitLine);
  const groups = groupCommits(commits);
  const section = formatSection(groups);

  const existing = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, 'utf8') : '';
  const updated = updateChangelog(existing, section);
  fs.writeFileSync(changelogPath, updated, 'utf8');

  console.log(`Updated ${changelogPath} with ${commits.length} commit(s).`);
}

if (require.main === module) {
  main();
}
