import { describe, it, expect } from 'vitest'
import { composeQuestionReply, type QuestionResolution } from '../questionReply'

const DELEGATE = 'Answer: You decide — make the call you judge best and tell me what you chose.'

describe('composeQuestionReply', () => {
  it('composes 3 questions mixing answer / delegate / delegate-with-note', () => {
    const questions = ['Which DB?', 'Name of the flag?', 'Ship behind a toggle?']
    const resolutions: QuestionResolution[] = [
      { kind: 'answer', text: '  Postgres  ' },
      { kind: 'delegate' },
      { kind: 'delegate', note: '  prefer off by default ' },
    ]
    expect(composeQuestionReply(questions, resolutions)).toBe(
      [
        'Answers to your questions:',
        '',
        '1. Which DB?',
        'Answer: Postgres',
        '',
        '2. Name of the flag?',
        DELEGATE,
        '',
        '3. Ship behind a toggle?',
        `${DELEGATE} My note: prefer off by default`,
      ].join('\n'),
    )
  })

  it('uses the singular header for one question; whitespace-only note is omitted', () => {
    expect(composeQuestionReply(['Proceed?'], [{ kind: 'delegate', note: '   ' }])).toBe(
      ['Answer to your question:', '', '1. Proceed?', DELEGATE].join('\n'),
    )
    expect(composeQuestionReply(['Proceed?'], [{ kind: 'answer', text: 'Yes' }])).toBe(
      'Answer to your question:\n\n1. Proceed?\nAnswer: Yes',
    )
  })

  it('keeps internal newlines of a multi-line answer', () => {
    expect(
      composeQuestionReply(['Steps?', 'Ok?'], [
        { kind: 'answer', text: '\nfirst line\nsecond line\n\nthird\n' },
        { kind: 'answer', text: 'ok' },
      ]),
    ).toBe(
      'Answers to your questions:\n\n1. Steps?\nAnswer: first line\nsecond line\n\nthird\n\n2. Ok?\nAnswer: ok',
    )
  })

  it('throws when resolutions.length !== questions.length', () => {
    expect(() => composeQuestionReply(['a', 'b'], [{ kind: 'delegate' }])).toThrow(Error)
  })

  it('throws when questions is empty', () => {
    expect(() => composeQuestionReply([], [])).toThrow(Error)
  })

  it('throws when an answer is empty after trimming', () => {
    expect(() => composeQuestionReply(['a'], [{ kind: 'answer', text: '  \n ' }])).toThrow(Error)
  })
})
