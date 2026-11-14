import { describe, expect, it } from 'vitest';
import { collapseCumulativeTextSnapshots } from './cumulativeTextSnapshots';

const text = (value: string) => ({ type: 'text', text: value });
const tool = { type: 'tool_use', id: 't1', name: 'Bash', input: {} };

describe('collapseCumulativeTextSnapshots', () => {
  it('keeps only the newest of adjacent cumulative text snapshots', () => {
    expect(collapseCumulativeTextSnapshots([text('A'), text('AB'), text('ABC')]))
      .toEqual([text('ABC')]);
  });

  it('collapses exact duplicate adjacent text blocks', () => {
    expect(collapseCumulativeTextSnapshots([text('Summary'), text('Summary')]))
      .toEqual([text('Summary')]);
  });

  it('collapses snapshots that follow a tool block without touching pre-tool text', () => {
    expect(collapseCumulativeTextSnapshots([text('pre '), tool, text('A'), text('AB'), text('ABC')]))
      .toEqual([text('pre '), tool, text('ABC')]);
  });

  it('keeps distinct adjacent text blocks', () => {
    const blocks = [text('First. '), text('Second. '), text('Thi')];
    expect(collapseCumulativeTextSnapshots(blocks)).toEqual(blocks);
  });

  it('does not merge text blocks separated by a non-text block', () => {
    const blocks = [text('Same'), tool, text('Same')];
    expect(collapseCumulativeTextSnapshots(blocks)).toEqual(blocks);
  });

  it('ignores whitespace-only blocks as snapshot prefixes', () => {
    const blocks = [text('\n'), text('\n\nHeading')];
    expect(collapseCumulativeTextSnapshots(blocks)).toEqual(blocks);
  });

  it('does not mutate the input array', () => {
    const blocks = [text('A'), text('AB')];
    collapseCumulativeTextSnapshots(blocks);
    expect(blocks).toEqual([text('A'), text('AB')]);
  });
});
