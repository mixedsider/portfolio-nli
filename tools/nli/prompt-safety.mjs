import { compact, normalize } from "./text.mjs";

const injectionPatterns = [
  /(?:ignore|disregard|bypass|forget|override).{0,40}(?:previous|prior|all|system|instruction|prompt|rule)/i,
  /(?:system|developer|hidden)\s*(?:prompt|message|instruction)/i,
  /(?:prompt\s*injection|jailbreak|dan\s*mode)/i,
  /(?:이전|앞선|모든|기존|시스템|개발자|내부|숨겨진).{0,24}(?:지시|명령|프롬프트|메시지|규칙).{0,24}(?:무시|공개|출력|보여|알려|따르지|잊어)/,
  /(?:지시|명령|규칙).{0,20}(?:무시|우회|잊고).{0,20}(?:프롬프트|규칙|제한|역할)/,
  /<\s*(?:script|iframe|img\b[^>]*\bon\w+\s*=)/i
];

export function isPromptInjectionAttempt(value) {
  const normalizedMessage = normalize(value);
  const compactMessage = compact(normalizedMessage);
  return injectionPatterns.some((pattern) => pattern.test(normalizedMessage) || pattern.test(compactMessage));
}
