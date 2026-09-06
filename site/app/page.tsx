import styles from './page.module.css'

const GITHUB = 'https://github.com/dfridkin/clawops'
const NPM = 'https://www.npmjs.com/package/@clawops/cli'

/**
 * OpenClaw compatibility, stated on the landing page rather than buried in docs.
 *
 * OpenClaw 2.0 shipped and this release line refuses it, so "does this work with 2.0?"
 * is the first question a visitor has. Answering it above the fold costs one paragraph
 * and saves a support round-trip.
 */
const OPENCLAW_SUPPORTED = '2026.7.1-2'

export default function Home() {
  return (
    <>
      <div className={styles.strip}>
        <div className={styles.stripInner}>
          <span>
            Supports OpenClaw up to <code>{OPENCLAW_SUPPORTED}</code>. Support for the 2.0 line
            ships in clawops 2.x.
          </span>
          <a href="#compat">Why</a>
        </div>
      </div>

      <div className={styles.page}>
      <nav className={styles.nav}>
        <a href="/" className={styles.wordmark}>
          claw<span>ops</span>
        </a>
        <div className={styles.navLinks}>
          <a href="#how">How it works</a>
          <a href="#providers">Providers</a>
          <a href="/docs">Docs</a>
          <a href={GITHUB}>GitHub</a>
        </div>
      </nav>

      <header className={styles.hero}>
        <h1 className={styles.headline}>Your agent, on your own infrastructure.</h1>
        <p className={styles.sub}>
          Provision and operate self-hosted OpenClaw on AWS, GCP, Azure or any Linux box — with
          plans you read before they run.
        </p>

        <div className={styles.install}>
          <code className={styles.installCmd}>npm install -g @clawops/cli</code>
        </div>

        <div className={styles.heroLinks}>
          <a className={styles.heroLink} href="/docs">
            Read the docs
          </a>
          <a className={styles.heroLink} href={GITHUB}>
            GitHub
          </a>
        </div>
      </header>

      {/* ── what it does ─────────────────────────────────── */}
      <section className={styles.section} id="how">
        <div className={styles.sectionHead}>
          <span className={styles.sectionNum}>01</span>
          <h2 className={styles.sectionTitle}>What it actually does</h2>
        </div>
        <p className={styles.lede}>
          Running an agent on your own hardware means owning a VM, a firewall, a container, secrets
          and an upgrade path. clawops owns that layer so you can treat the gateway as a deployment
          target rather than a pet.
        </p>

        <div className={styles.grid}>
          <article className={styles.card}>
            <h3 className={styles.cardTitle}>Plans you can read before they run</h3>
            <p className={styles.cardBody}>
              <code>clawops plan</code> emits a JSON artifact you review, diff and commit.{' '}
              <code>clawops apply</code> executes exactly that. Nothing reaches your cloud account
              straight from a natural-language instruction.
            </p>
          </article>

          <article className={styles.card}>
            <h3 className={styles.cardTitle}>Pulumi, embedded</h3>
            <p className={styles.cardBody}>
              The Automation API runs in-process. No separate Pulumi install, no CLI to keep in step,
              no state backend to stand up before your first deploy.
            </p>
          </article>

          <article className={styles.card}>
            <h3 className={styles.cardTitle}>Deny-all by default</h3>
            <p className={styles.cardBody}>
              Security groups and firewalls start closed. SSH and gateway ports open only to CIDRs
              your plan names explicitly — never <code>0.0.0.0/0</code>.
            </p>
          </article>

          <article className={styles.card}>
            <h3 className={styles.cardTitle}>Credentials stay where they are</h3>
            <p className={styles.cardBody}>
              clawops reads your existing CLI profiles — <code>AWS_PROFILE</code>, gcloud ADC, Azure
              env. It stores no cloud credentials of its own, anywhere.
            </p>
          </article>

          <article className={styles.card}>
            <h3 className={styles.cardTitle}>An MCP server, not a chat wrapper</h3>
            <p className={styles.cardBody}>
              Every operation is a typed tool with explicit safety annotations, so a coding agent
              knows what is read-only, what is destructive, and what needs confirmation.
            </p>
          </article>

          <article className={styles.card}>
            <h3 className={styles.cardTitle}>Day-two operations</h3>
            <p className={styles.cardBody}>
              <code>logs</code>, <code>ssh</code>, <code>tunnel</code>, <code>monitor</code>,{' '}
              <code>backup</code>, <code>harden</code> — the things you need on day two, not just
              the first deploy.
            </p>
          </article>
        </div>
      </section>

      {/* ── quickstart ───────────────────────────────────── */}
      <section className={styles.section} id="quickstart">
        <div className={styles.sectionHead}>
          <span className={styles.sectionNum}>02</span>
          <h2 className={styles.sectionTitle}>Quickstart</h2>
        </div>
        <p className={styles.lede}>
          The local path needs a Linux box you can SSH into — no cloud account required to try it.
          The <a href="/docs/quickstart">full quickstart</a> covers cloud providers and day-two
          operations.
        </p>

        <div className={styles.flow}>
          <div className={styles.step}>
            <span className={styles.stepNum}>01</span>
            <div className={styles.stepBody}>
              <h3>Install and check your machine</h3>
              <p>
                <code>doctor</code> verifies Node, SSH keys, known_hosts and cloud credentials before
                anything is provisioned.
              </p>
              <pre>{`npm install -g @clawops/cli
clawops doctor`}</pre>
            </div>
          </div>

          <div className={styles.step}>
            <span className={styles.stepNum}>02</span>
            <div className={styles.stepBody}>
              <h3>Point it at a host</h3>
              <p>Any reachable Ubuntu, Debian or RHEL box. Docker is installed for you.</p>
              <pre>{`clawops init --provider local --host 10.0.0.42`}</pre>
            </div>
          </div>

          <div className={styles.step}>
            <span className={styles.stepNum}>03</span>
            <div className={styles.stepBody}>
              <h3>Deploy</h3>
              <p>
                Pin a version rather than a moving tag — <code>latest</code> and <code>stable</code>{' '}
                both point at OpenClaw 2.0, which this line does not support.
              </p>
              <pre>{`clawops up --openclaw-version ${OPENCLAW_SUPPORTED}`}</pre>
            </div>
          </div>

          <div className={styles.step}>
            <span className={styles.stepNum}>04</span>
            <div className={styles.stepBody}>
              <h3>Reach the gateway</h3>
              <p>Forward the port over SSH rather than exposing it to the internet.</p>
              <pre>{`clawops tunnel
# Control UI on http://127.0.0.1:18789`}</pre>
            </div>
          </div>
        </div>
      </section>

      {/* ── providers ────────────────────────────────────── */}
      <section className={styles.section} id="providers">
        <div className={styles.sectionHead}>
          <span className={styles.sectionNum}>03</span>
          <h2 className={styles.sectionTitle}>Providers</h2>
        </div>

        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Compute</th>
                <th>Plan / apply</th>
                <th>Secret store</th>
                <th>Hardening</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>AWS</td>
                <td>EC2</td>
                <td className={styles.yes}>yes</td>
                <td>Secrets Manager, SSM</td>
                <td className={styles.yes}>yes</td>
              </tr>
              <tr>
                <td>GCP</td>
                <td>Compute Engine</td>
                <td className={styles.yes}>yes</td>
                <td>Secret Manager</td>
                <td className={styles.no}>v1.8</td>
              </tr>
              <tr>
                <td>Azure</td>
                <td>Linux VM</td>
                <td className={styles.yes}>yes</td>
                <td>Key Vault</td>
                <td className={styles.no}>v1.8</td>
              </tr>
              <tr>
                <td>Local / any VM</td>
                <td>SSH</td>
                <td className={styles.no}>use <code>up</code></td>
                <td>env, file</td>
                <td className={styles.yes}>yes</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* ── what it doesn't do ───────────────────────────── */}
      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionNum}>04</span>
          <h2 className={styles.sectionTitle}>What it does not do</h2>
        </div>
        <p className={styles.lede}>
          Worth knowing before you install it, rather than after.
        </p>

        <div className={styles.limits}>
          <div className={styles.limit}>
            <h3>One node per stack</h3>
            <p>
              No clustering, load balancing or failover. For high availability, run multiple stacks
              and route between them yourself.
            </p>
          </div>
          <div className={styles.limit}>
            <h3>No TLS or domain automation yet</h3>
            <p>
              The gateway is reached over an SSH tunnel or a reverse proxy you bring. Certificate and
              DNS automation is planned, not shipped.
            </p>
          </div>
          <div className={styles.limit}>
            <h3>It manages the host, not your agent</h3>
            <p>
              clawops provisions and operates the infrastructure OpenClaw runs on. Authoring agents,
              skills and prompts is OpenClaw&rsquo;s job.
            </p>
          </div>
          <div className={styles.limit}>
            <h3>No cost estimation</h3>
            <p>
              clawops will not tell you what a stack costs before you create it. Check your
              provider&rsquo;s calculator for the instance type you choose.
            </p>
          </div>
        </div>
      </section>

      <section className={styles.section} id="compat">
        <div className={styles.sectionHead}>
          <span className={styles.sectionNum}>05</span>
          <h2 className={styles.sectionTitle}>OpenClaw 2.0</h2>
        </div>
        <div className={styles.limits}>
          <div className={styles.limit}>
            <h3>This line supports OpenClaw up to {OPENCLAW_SUPPORTED}</h3>
            <p>
              OpenClaw <code>2026.8.1</code> changed the container runtime contract: state moved
              into SQLite, config moved to a writable path, and model providers became
              install-gated plugins.
            </p>
          </div>
          <div className={styles.limit}>
            <h3>clawops refuses what it cannot deploy correctly</h3>
            <p>
              Rather than producing a crash-looping gateway, <code>doctor</code>, <code>plan</code>,{' '}
              <code>up</code> and <code>apply</code> reject an unsupported version and say which
              release line to use. Pin a version — <code>latest</code> and <code>stable</code> both
              point at 2.0.
            </p>
          </div>
          <div className={styles.limit}>
            <h3>Already deployed 2.0?</h3>
            <p>
              <code>clawops doctor --stack &lt;name&gt;</code> reports the version a gateway is
              actually running, so a deployment that picked up 2.0 through a moving tag can be
              identified. Support for the 2.0 line ships in clawops 2.x, with a migration command
              for existing deployments.
            </p>
          </div>
        </div>
      </section>

      <footer className={styles.footer}>
        <span>
          MPL-2.0 &middot; <a href="/docs">Docs</a> &middot; <a href={GITHUB}>GitHub</a> &middot;{' '}
          <a href={NPM}>npm</a>
        </span>
        <span>
          Not affiliated with OpenClaw. <code>clawctl.com</code> is an unrelated project.
        </span>
      </footer>
      </div>
    </>
  )
}
