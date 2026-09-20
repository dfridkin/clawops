import styles from './page.module.css'
import HeroIntro from './components/HeroIntro'
import Atmosphere from './components/Atmosphere'

const GITHUB = 'https://github.com/dfridkin/clawops'
const NPM = 'https://www.npmjs.com/package/@clawops/cli'

/**
 * OpenClaw compatibility, stated on the landing page rather than buried in docs.
 *
 * "Does this work with 2.0?" is the first question a visitor has. Answering it above the
 * fold costs one line and saves a support round-trip. This line requires 2.0; the previous
 * one is maintained under the `legacy` dist-tag.
 */
const OPENCLAW_SUPPORTED = '2026.9.2'

export default function Home() {
  return (
    <>
      {/*
        The strip and the hero share one pinned-chrome scope. Everything inside renders in the
        Win95 light palette in both themes, the WebGL shell included, because the shell reads
        its own colours off the canvas's computed style.
      */}
      <div className={styles.chromeTop}>
        <div className={styles.strip}>
          <div className={styles.stripInner}>
            <span>
              <strong>OpenClaw 2.0 support is live</strong> in clawops 2.0: state that survives a
              restart, plugins installed for you, and <code>clawops migrate</code> to bring an
              existing 1.x deployment across.
            </span>
            <a href="/docs/migrating">Migrating from 1.x</a>
          </div>
        </div>

        <div className={styles.heroBand}>
          <Atmosphere kind="smoke" className={styles.smoke} />
          <div className={styles.heroInner}>
            <nav className={styles.nav}>
              <a href="/" className={styles.wordmark}>
                claw<span>ops</span>
              </a>
              <a href="#how">How it works</a>
              <a href="#providers">Providers</a>
              <a href="/docs">Docs</a>
              <span className={styles.navSpacer} />
              <a href={GITHUB} className={styles.navOn}>
                GitHub
              </a>
            </nav>

            <header className={styles.hero}>
              <div className={styles.heroCopy}>
                <h1 className={styles.headline}>Your agent, on your own infrastructure.</h1>
                <p className={styles.sub}>
                  Provision and operate self-hosted OpenClaw on AWS, GCP, Azure or any Linux box,
                  with plans you read before they run.
                </p>

                <div className={`${styles.install} ${styles.sunken}`}>
                  <code className={styles.installCmd}>npm install -g @clawops/cli</code>
                </div>

                <div className={styles.heroLinks}>
                  <a className={`${styles.heroLink} ${styles.heroLinkPrimary}`} href="/docs">
                    Read the docs
                  </a>
                  <a className={styles.heroLink} href={GITHUB}>
                    GitHub
                  </a>
                </div>
              </div>

              <div className={styles.heroArt}>
                <HeroIntro />
              </div>
            </header>
          </div>
        </div>
      </div>

      <div className={styles.page}>
        <div className={styles.sections}>
          {/* ── what it does: the page's one saturated block ── */}
          <section className={`${styles.section} ${styles.field}`} id="how">
            <div className={styles.sectionHead}>
              <span className={styles.chip}>01</span>
              <h2 className={styles.sectionTitle}>What it actually does</h2>
            </div>
            <p className={styles.lede}>
              Running an agent on your own hardware means owning a VM, a firewall, a container,
              secrets and an upgrade path. clawops owns that layer so you can treat the gateway as
              a deployment target rather than a pet.
            </p>

            <div className={styles.grid}>
              <article className={`${styles.card} ${styles.raised}`}>
                <span className={styles.chip}>plan</span>
                <h3 className={styles.cardTitle}>Plans you can read before they run</h3>
                <p className={styles.cardBody}>
                  <code>clawops plan</code> emits a JSON artifact you review, diff and commit.{' '}
                  <code>clawops apply</code> executes exactly that. Nothing reaches your cloud
                  account straight from a natural-language instruction.
                </p>
              </article>

              <article className={`${styles.card} ${styles.raised}`}>
                <span className={styles.chip}>pulumi</span>
                <h3 className={styles.cardTitle}>Pulumi, handled for you</h3>
                <p className={styles.cardBody}>
                  clawops installs the Pulumi CLI it needs on first use, or uses a compatible one
                  already on your PATH. Your state lives in your own bucket, and clawops offers to
                  create it.
                </p>
              </article>

              <article className={`${styles.card} ${styles.raised}`}>
                <span className={styles.chip}>network</span>
                <h3 className={styles.cardTitle}>Deny-all by default</h3>
                <p className={styles.cardBody}>
                  Security groups and firewalls start closed. SSH and gateway ports open only to
                  CIDRs your plan names explicitly, never <code>0.0.0.0/0</code>.
                </p>
              </article>

              <article className={`${styles.card} ${styles.raised}`}>
                <span className={styles.chip}>creds</span>
                <h3 className={styles.cardTitle}>Credentials stay where they are</h3>
                <p className={styles.cardBody}>
                  clawops reads your existing CLI profiles: <code>AWS_PROFILE</code>, gcloud ADC,
                  Azure env. It stores no cloud credentials of its own, anywhere.
                </p>
              </article>

              <article className={`${styles.card} ${styles.raised}`}>
                <span className={styles.chip}>mcp</span>
                <h3 className={styles.cardTitle}>An MCP server, not a chat wrapper</h3>
                <p className={styles.cardBody}>
                  Every operation is a typed tool with explicit safety annotations, so a coding
                  agent knows what is read-only, what is destructive, and what needs confirmation.
                </p>
              </article>

              <article className={`${styles.card} ${styles.raised}`}>
                <span className={styles.chip}>day two</span>
                <h3 className={styles.cardTitle}>Day-two operations</h3>
                <p className={styles.cardBody}>
                  <code>logs</code>, <code>ssh</code>, <code>tunnel</code>, <code>monitor</code>,{' '}
                  <code>backup</code>, <code>migrate</code>, <code>harden</code>: the things you
                  need on day two, not just the first deploy.
                </p>
              </article>
            </div>
          </section>

          {/* ── quickstart ───────────────────────────────────── */}
          <section className={styles.section} id="quickstart">
            <Atmosphere kind="edge" className={styles.edge} />
            <div className={styles.sectionHead}>
              <span className={styles.chip}>02</span>
              <h2 className={styles.sectionTitle}>Quickstart</h2>
            </div>
            <p className={styles.lede}>
              The local path needs a Linux box you can SSH into, with no cloud account required to
              try it. The <a href="/docs/quickstart">full quickstart</a> covers cloud providers and
              day-two operations.
            </p>

            <div className={styles.flow}>
              <div className={styles.step}>
                <span className={styles.chip}>01</span>
                <div className={styles.stepBody}>
                  <h3>Install and check your machine</h3>
                  <p>
                    <code>doctor</code> verifies Node, SSH keys, known_hosts and cloud credentials
                    before anything is provisioned.
                  </p>
                  <pre>{`npm install -g @clawops/cli
clawops doctor`}</pre>
                </div>
              </div>

              <div className={styles.step}>
                <span className={styles.chip}>02</span>
                <div className={styles.stepBody}>
                  <h3>Point it at a host</h3>
                  <p>Any reachable Ubuntu, Debian or RHEL box. Docker is installed for you.</p>
                  <pre>{`clawops init --provider local --host 10.0.0.42`}</pre>
                </div>
              </div>

              <div className={styles.step}>
                <span className={styles.chip}>03</span>
                <div className={styles.stepBody}>
                  <h3>Deploy</h3>
                  <p>
                    Pin a version rather than a moving tag. clawops refuses <code>latest</code> and{' '}
                    <code>stable</code>: a tag that moves changes what is deployed without changing
                    the plan.
                  </p>
                  <pre>{`clawops up --openclaw-version ${OPENCLAW_SUPPORTED}`}</pre>
                </div>
              </div>

              <div className={styles.step}>
                <span className={styles.chip}>04</span>
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
              <span className={styles.chip}>03</span>
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
                    <td>
                      <span className={styles.chip}>AWS</span>
                    </td>
                    <td>EC2</td>
                    <td className={styles.yes}>yes</td>
                    <td>Secrets Manager, SSM</td>
                    <td className={styles.yes}>yes</td>
                  </tr>
                  <tr>
                    <td>
                      <span className={styles.chip}>GCP</span>
                    </td>
                    <td>Compute Engine</td>
                    <td className={styles.yes}>yes</td>
                    <td>Secret Manager</td>
                    <td className={styles.yes}>yes</td>
                  </tr>
                  <tr>
                    <td>
                      <span className={styles.chip}>Azure</span>
                    </td>
                    <td>Linux VM</td>
                    <td className={styles.yes}>yes</td>
                    <td>Key Vault</td>
                    <td className={styles.yes}>yes</td>
                  </tr>
                  <tr>
                    <td>
                      <span className={styles.chip}>Local / any VM</span>
                    </td>
                    <td>SSH</td>
                    <td className={styles.no}>
                      use <code>up</code>
                    </td>
                    <td>env, file</td>
                    <td className={styles.yes}>yes</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          {/* ── what it doesn't do ───────────────────────────── */}
          <section className={styles.section}>
            <Atmosphere kind="edge" flip className={styles.edge} />
            <div className={styles.sectionHead}>
              <span className={styles.chip}>04</span>
              <h2 className={styles.sectionTitle}>What it does not do</h2>
            </div>
            <p className={styles.lede}>Worth knowing before you install it, rather than after.</p>

            <div className={styles.limits}>
              <div className={styles.limit}>
                <h3>One node per stack</h3>
                <p>
                  No clustering, load balancing or failover. For high availability, run multiple
                  stacks and route between them yourself.
                </p>
              </div>
              <div className={styles.limit}>
                <h3>No TLS or domain automation yet</h3>
                <p>
                  The gateway is reached over an SSH tunnel or a reverse proxy you bring.
                  Certificate and DNS automation is planned, not shipped.
                </p>
              </div>
              <div className={styles.limit}>
                <h3>It manages the host, not your agent</h3>
                <p>
                  clawops provisions and operates the infrastructure OpenClaw runs on. Authoring
                  agents, skills and prompts is OpenClaw&rsquo;s job.
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

          {/* ── compatibility, as a footnote rather than a pre-condition ── */}
          <section className={styles.section} id="compat">
            <div className={styles.sectionHead}>
              <span className={styles.chip}>05</span>
              <h2 className={styles.sectionTitle}>OpenClaw 2.0</h2>
            </div>
            <div className={styles.limits}>
              <div className={styles.limit}>
                <h3>This line requires OpenClaw {OPENCLAW_SUPPORTED} or later</h3>
                <p>
                  OpenClaw <code>2026.8.1</code> changed the container runtime contract: state
                  moved into SQLite, config moved to a writable path, and model providers, then
                  channels, became install-gated plugins. clawops mounts the state directory,
                  validates config against OpenClaw&rsquo;s own schema before writing it, and
                  installs the plugins your config names during <code>apply</code>.
                </p>
              </div>
              <div className={styles.limit}>
                <h3>Coming from 1.x</h3>
                <p>
                  <code>clawops migrate</code> takes a verified backup, extracts the state from the
                  running container, and starts 2.0 against it. Device identity is preserved, so
                  paired devices do not need re-pairing. Your old config is not applied, since on
                  1.x it was read by nothing, so a valid 2.0 config is written and the old one
                  reported for review.
                </p>
              </div>
              <div className={styles.limit}>
                <h3>Still on the older runtime?</h3>
                <p>
                  The 1.x line is maintained under the <code>legacy</code> dist-tag until
                  2027-03-31 for OpenClaw <code>2026.7.1-2</code> and earlier:{' '}
                  <code>npm install -g @clawops/cli@legacy</code>.
                </p>
              </div>
            </div>
          </section>
        </div>

        {/*
          One status bar. The links are cells too, pushed right by the grow spacer the way a
          Win95 status bar puts its own right-hand affordance. No version numbers: a status bar
          that has to be edited on every release is a status bar that goes stale.
        */}
        <footer className={styles.footer}>
          <div className={`${styles.status} ${styles.raised}`}>
            <div className={`${styles.cell} ${styles.sunken}`}>@clawops/cli</div>
            <div className={`${styles.cell} ${styles.sunken}`}>latest &middot; legacy</div>
            <div className={`${styles.cell} ${styles.sunken}`}>
              OpenClaw &gt;= {OPENCLAW_SUPPORTED}
            </div>
            <div className={`${styles.cell} ${styles.sunken}`}>MPL-2.0</div>
            <div className={`${styles.cell} ${styles.sunken} ${styles.cellGrow}`}>&nbsp;</div>
            <a className={`${styles.cell} ${styles.sunken}`} href="/docs">
              Docs
            </a>
            <a className={`${styles.cell} ${styles.sunken}`} href={GITHUB}>
              GitHub
            </a>
            <a className={`${styles.cell} ${styles.sunken}`} href={NPM}>
              npm
            </a>
          </div>
        </footer>
      </div>
    </>
  )
}
