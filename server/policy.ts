import { db } from './db.ts'
import { reviewPrompt, type PolicyRuleInput, type PromptReview } from './provider.ts'

export type CheckResult = PromptReview & {
  checkId: number
  blockedBy: 'keyword' | 'ai' | null
  keyword?: string
  rules: { id: number; name: string; action: string }[]
}

export function activeRules(): Promise<PolicyRuleInput[]> {
  return db.all<PolicyRuleInput>('SELECT id, name, description, action FROM policy_rules WHERE active = 1 ORDER BY id')
}

const normalize = (s: string) => s.toLowerCase().replace(/[ً-ْ]/g, '').replace(/[أإآ]/g, 'ا')

export async function keywordHit(text: string): Promise<string | undefined> {
  const words = await db.all<{ word: string }>('SELECT word FROM blocked_keywords')
  const t = normalize(text)
  // Drop a leading "ال" so "الصحابة" also catches "للصحابة" and "صحابة".
  return words.find((w) => t.includes(normalize(w.word).replace(/^ال(?=\S{3})/, '')))?.word
}

// Layer 1 is the ministry's blocklist (instant, free). Layer 2 is Gemini Flash on Vertex AI reading the
// prompt against the rules. The prompt itself is not translated or changed.
export async function checkPrompt(userId: number, prompt: string): Promise<CheckResult> {
  const rules = await activeRules()
  const kw = await keywordHit(prompt)
  let review: PromptReview
  let blockedBy: CheckResult['blockedBy'] = null
  if (kw) {
    review = {
      allowed: false, needsReview: false, ruleIds: [],
      reasonEn: `“${kw}” is on the Ministry’s blocklist.`, reasonAr: `كلمة «${kw}» ممنوعة في سياسة المحتوى.`,
      enhancedPrompt: '', safeAlternative: '', sourceLanguage: /[؀-ۿ]/.test(prompt) ? 'ar' : 'en',
    }
    blockedBy = 'keyword'
  } else {
    review = await reviewPrompt(prompt, rules)
    if (!review.allowed) blockedBy = 'ai'
  }
  const matched = rules.filter((r) => review.ruleIds.includes(r.id)).map((r) => ({ id: r.id, name: r.name, action: r.action }))
  const checkId = await db.insert(`INSERT INTO prompt_checks (user_id, prompt, enhanced, allowed, result, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    userId, prompt, review.enhancedPrompt, review.allowed ? 1 : 0, JSON.stringify({ ...review, blockedBy, keyword: kw, rules: matched }), Date.now())
  return { ...review, checkId, blockedBy, keyword: kw, rules: matched }
}
