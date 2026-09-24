import defaultMdxComponents from 'fumadocs-ui/mdx'
import type { MDXComponents } from 'mdx/types'
import { Faq } from '@/app/components/Faq'

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  // Faq renders the questions and their structured data from one array; see faq-data.ts.
  return { ...defaultMdxComponents, Faq, ...components }
}
