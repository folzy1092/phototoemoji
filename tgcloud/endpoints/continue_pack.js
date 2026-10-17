// endpoints/continue_pack.js — the Mini App calls this in a loop; each call is
// a fresh invocation with its own upload budget, so it uploads the next chunk.

import { EndpointError } from 'sdk';
import { runStep, stepFailed, describeError } from '../lib/pack.js';
import { userLang } from '../lib/i18n.js';

export default async function (input, ctx) {
  const jobId = Number(input.jobId);
  if (!Number.isInteger(jobId)) throw new EndpointError('Bad job id', { code: 'BAD_INPUT' });
  const user = ctx.initData.user;
  const lang = await userLang(user.id, user.language_code); // the Mini App shows its texts in it
  try {
    return { ...(await runStep(jobId, user)), lang };
  } catch (e) {
    await stepFailed(jobId, e, user);
    throw new EndpointError(describeError(e, lang), { code: 'STEP_FAILED', lang });
  }
}
