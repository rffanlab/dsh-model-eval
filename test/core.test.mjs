import test from 'node:test'
import assert from 'node:assert/strict'
import { artifactKind, joinApi, judgeJson, normalizeConfig, scoreCases } from '../src/core.js'

test('normalizeConfig validates and normalizes endpoint', () => {
  const value = normalizeConfig({ baseUrl:'http://127.0.0.1:8001/v1/', suite:'full', declaredContext:'131072' })
  assert.equal(value.baseUrl, 'http://127.0.0.1:8001/v1')
  assert.equal(value.declaredContext, 131072)
  assert.equal(value.suite, 'full')
})

test('joinApi avoids duplicated v1', () => {
  assert.equal(joinApi('http://x/v1','/v1/models'),'http://x/v1/models')
  assert.equal(joinApi('http://x/v1','/models'),'http://x/v1/models')
})

test('strict json evaluator rejects extra fields', () => {
  assert.equal(judgeJson('{"alpha":17,"beta":"ok"}',{alpha:17,beta:'ok'}).passed,true)
  assert.equal(judgeJson('{"alpha":17,"beta":"ok","extra":1}',{alpha:17,beta:'ok'}).passed,false)
})

test('artifact kinds include media and office documents', () => {
  assert.equal(artifactKind('a.png'),'image')
  assert.equal(artifactKind('a.mp4'),'video')
  assert.equal(artifactKind('a.docx'),'document')
})

test('scoreCases excludes skipped from denominator', () => {
  const score = scoreCases([{status:'passed'},{status:'failed'},{status:'skipped'}])
  assert.equal(score.scored,2)
  assert.equal(score.passRate,0.5)
})
