import { expect, test } from 'vitest'
import { price } from './index.js'

test('price prints euros with cents', () => {
  expect(price(1250)).toBe('€12.50')
})
