import Link from 'next/link'
import { FAQ } from './faq-data'

/**
 * The FAQ, rendered for people and for the machines that answer on their behalf.
 *
 * Both come from one array, so the page and its structured data cannot disagree. The headings are
 * the questions verbatim: an assistant matching a query to a page matches the question it was
 * asked, and a heading that paraphrases it is a heading that does not match.
 */
export function Faq(): React.ReactElement {
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: FAQ.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: { '@type': 'Answer', text: item.answer },
    })),
  }

  return (
    <>
      <script
        type="application/ld+json"
        // Built from the literal above; nothing here comes from user input.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
      />
      {FAQ.map((item) => (
        <section key={item.question}>
          <h2 id={slug(item.question)}>{item.question}</h2>
          <p>
            {item.answer}
            {item.more ? (
              <>
                {' '}
                <Link href={item.more.href}>{item.more.label}</Link>.
              </>
            ) : null}
          </p>
        </section>
      ))}
    </>
  )
}

/** Stable anchors, so a link to one answer keeps working when another is added above it. */
function slug(question: string): string {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}
