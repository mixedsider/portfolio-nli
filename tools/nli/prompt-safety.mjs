import { normalize } from "./text.mjs";

const injectionPatterns = [
  /(?:ignore|disregard|bypass).{0,40}(?:previous|prior|all|system|instruction|prompt)/i,
  /(?:system|developer)\s*(?:prompt|message|instruction)/i,
  /(?:prompt\s*injection|jailbreak|dan\s*mode)/i,
  /(?:이전|앞선|모든|시스템|개발자).{0,24}(?:지시|명령|프롬프트|메시지).{0,24}(?:무시|공개|출력|보여|따르지)/,
  /(?:지시|명령).{0,20}(?:무시|우회).{0,20}(?:프롬프트|규칙|제한)/
];

export function isPromptInjectionAttempt(value) {
  const normalizedMessage = normalize(value);
  return injectionPatterns.some((pattern) => pattern.test(normalizedMessage));
}
