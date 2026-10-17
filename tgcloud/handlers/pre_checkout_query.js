// handlers/pre_checkout_query.js — confirm a Stars payment for a pack draft.

import { api } from '../lib/premium.js'; // premium emoji applied
import { checkPayment } from '../lib/draft.js';
import { logError, esc } from '../lib/log.js';
import { tr } from '../lib/i18n.js';

export default async function (query) {
  try {
    await checkPayment(query);
  } catch (e) {
    console.error(e);
    await logError('Ошибка проверки оплаты', { user: query.from, lines: [esc(e && e.message)] });
    const T = await tr(query.from.id, query.from.language_code);
    await api.answerPreCheckoutQuery({ pre_checkout_query_id: query.id, ok: false, error_message: T('pay_check_failed') });
  }
}
