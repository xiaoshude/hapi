import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Root } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

describe('remark-gfm iOS WebKit compatibility', () => {
    it('does not use regex lookbehind in the GFM email autolinker', () => {
        const requireFromTest = createRequire(import.meta.url)
        const remarkGfmEntry = requireFromTest.resolve('remark-gfm')
        const requireFromRemarkGfm = createRequire(remarkGfmEntry)
        const autolinkEntry = requireFromRemarkGfm.resolve('mdast-util-gfm-autolink-literal')
        const autolinkSource = readFileSync(resolve(dirname(autolinkEntry), 'lib/index.js'), 'utf8')

        expect(autolinkSource).not.toContain('(?<=')
    })

    it('keeps email links and surrounding punctuation intact', () => {
        const processor = unified().use(remarkParse).use(remarkGfm)
        const parsed = processor.parse('Contact: (user@example.com).')
        const tree = processor.runSync(parsed) as Root
        const paragraph = tree.children[0]

        expect(paragraph.type).toBe('paragraph')
        if (paragraph.type !== 'paragraph') return

        expect(paragraph.children).toHaveLength(3)
        expect(paragraph.children[0]).toMatchObject({ type: 'text', value: 'Contact: (' })
        expect(paragraph.children[1]).toMatchObject({
            type: 'link',
            url: 'mailto:user@example.com',
            children: [{ type: 'text', value: 'user@example.com' }],
        })
        expect(paragraph.children[2]).toMatchObject({ type: 'text', value: ').' })
    })
})
