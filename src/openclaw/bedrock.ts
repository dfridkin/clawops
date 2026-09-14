// Resolving a Bedrock model id to something Bedrock will actually accept.
//
// Bedrock refuses a bare foundation-model id outright:
//
//   Validation error: Invocation of model ID anthropic.claude-haiku-4-5-20251001-v1:0 with
//   on-demand throughput isn't supported. Retry your request with the ID or ARN of an
//   inference profile that contains…
//
// The usable id is an inference profile — `us.anthropic.claude-haiku-4-5-20251001-v1:0`. The
// prefix is a geography, and `ListInferenceProfiles` is region-scoped: queried from
// us-east-1 it returns `us.` and `global.` profiles and nothing else. So the right id cannot
// be written into a catalog; it depends on where the stack is being deployed.
//
// Resolved at plan time rather than guessed, for the same reason a moving image tag is
// resolved before it is range-checked: the plan is the artifact someone reviews, and it
// should say exactly what will be deployed. See docs/spikes/SP-12-bedrock-config-shape.md.

export interface InferenceProfile {
  inferenceProfileId: string
}

export type ProfileResolution =
  | { ok: true; profileId: string; why: string }
  | { ok: false; error: string }

/**
 * Pick the inference profile for a foundation-model id.
 *
 * Prefers a geography-specific profile over `global.`: a regional profile keeps inference in
 * the geography the stack was deployed to, which is usually why a region was chosen at all.
 * `global.` is accepted as a fallback because some models only publish that form.
 */
export function resolveInferenceProfile(
  foundationModelId: string,
  profiles: InferenceProfile[],
  region: string,
): ProfileResolution {
  const candidates = profiles
    .map((p) => p.inferenceProfileId)
    .filter((id) => id.endsWith(`.${foundationModelId}`))

  if (candidates.length === 0) {
    return {
      ok: false,
      error:
        `No Bedrock inference profile for "${foundationModelId}" in ${region}. ` +
        `Bedrock refuses bare foundation-model ids for on-demand inference, so this model ` +
        `cannot be used there. Check the model is enabled in this region, or choose another.`,
    }
  }

  const geo = geographyFor(region)
  const regional = candidates.find((id) => id.startsWith(`${geo}.`))
  if (regional) return { ok: true, profileId: regional, why: `${geo} profile for ${region}` }

  const global = candidates.find((id) => id.startsWith('global.'))
  if (global) {
    return {
      ok: true,
      profileId: global,
      why: `no ${geo} profile for ${region}; using the global profile`,
    }
  }

  // Something matched but in neither this geography nor global — deploying it would send
  // inference somewhere the operator did not choose.
  return {
    ok: false,
    error:
      `Bedrock has inference profiles for "${foundationModelId}" (${candidates.join(', ')}) ` +
      `but none for ${region} or global. Using one would route inference to another ` +
      `geography; choose a region where the model is offered.`,
  }
}

/**
 * The inference-profile geography for an AWS region.
 *
 * Derived from the region prefix rather than a hand-maintained list of every region, so a new
 * region in an existing geography works without a code change. Unknown prefixes fall through
 * to the region itself, which will simply not match and produce the "no profile" error above
 * rather than a wrong guess.
 */
export function geographyFor(region: string): string {
  const prefix = region.split('-')[0] ?? region
  if (prefix === 'ap') return 'apac'
  return prefix
}

/**
 * Every inference profile Bedrock offers in a region.
 *
 * Region-scoped by design: the client is constructed for the deployment region, so the
 * answer describes where the stack will actually run rather than where clawops happens to be
 * configured. Credentials come from the ambient AWS chain, never from arguments (R6).
 *
 * Returns a Result rather than throwing: a missing `bedrock:ListInferenceProfiles` permission
 * is an ordinary condition for an operator who does not use Bedrock, and it should read as a
 * clear message rather than a stack trace.
 */
export async function fetchInferenceProfiles(
  region: string,
  signal?: AbortSignal,
): Promise<{ ok: true; profiles: InferenceProfile[] } | { ok: false; error: string }> {
  try {
    const { BedrockClient, ListInferenceProfilesCommand } = await import('@aws-sdk/client-bedrock')
    const client = new BedrockClient({ region })
    const profiles: InferenceProfile[] = []
    let nextToken: string | undefined

    // Paginated, and the list is long enough to need it — us-east-1 alone returns 75.
    do {
      const page = await client.send(
        new ListInferenceProfilesCommand({ maxResults: 100, nextToken }),
        { abortSignal: signal },
      )
      for (const p of page.inferenceProfileSummaries ?? []) {
        if (p.inferenceProfileId) profiles.push({ inferenceProfileId: p.inferenceProfileId })
      }
      nextToken = page.nextToken
    } while (nextToken)

    return { ok: true, profiles }
  } catch (err) {
    return {
      ok: false,
      error:
        `Could not list Bedrock inference profiles in ${region}: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `The deploying identity needs bedrock:ListInferenceProfiles.`,
    }
  }
}
