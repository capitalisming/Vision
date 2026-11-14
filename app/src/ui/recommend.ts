import type { Assessment } from '../core/baseline';

export interface Advice {
  tone: 'ok' | 'info' | 'warn' | 'alert';
  title: string;
  action: string;
}

const f = (x: number | null) => (x == null ? '—' : (x >= 0 ? '+' : '') + x.toFixed(2));

/** Wording of the decision rule. PROPOSED: thresholds and actions need clinical review. */
export function advise(a: Assessment): Advice {
  switch (a.status) {
    case 'need_baseline':
      return {
        tone: 'info',
        title: 'Собираем личную норму',
        action: a.sessionsToBaseline > 0
          ? `Нужно ещё ${a.sessionsToBaseline} тест(а) в разные дни, в тех же очках и при том же освещении.`
          : 'Норма сформирована по этим сессиям. Следующие тесты будут сравниваться с ней.',
      };
    case 'low_quality':
      return { tone: 'warn', title: 'Результат недостаточно точный', action: 'Ответы были противоречивы. Повторите тест сейчас, без спешки.' };
    case 'stable':
      return { tone: 'ok', title: 'Без изменений', action: `Изменение ${f(a.delta)} logMAR в пределах вашего обычного разброса (±${a.limit?.toFixed(2)}).` };
    case 'better':
      return {
        tone: 'info',
        title: 'Лучше вашей нормы',
        action: `Изменение ${f(a.delta)} logMAR. Проверьте, что очки и освещение те же, что при сборе нормы.`,
      };
    case 'possible_worsening':
      return {
        tone: 'warn',
        title: 'Возможное ухудшение',
        action: `Хуже нормы на ${f(a.delta)} logMAR (обычный разброс ±${a.limit?.toFixed(2)}). Повторите тест завтра в тех же условиях.`,
      };
    case 'confirmed_worsening':
      return {
        tone: 'alert',
        title: 'Ухудшение подтверждено',
        action: 'Два теста подряд хуже нормы. Наденьте очки следующей силы из запасного комплекта и пройдите тест в них. Сообщите врачу на плановой связи.',
      };
    case 'large_worsening':
      return { tone: 'alert', title: 'Сильное ухудшение', action: `Хуже нормы на ${f(a.delta)} logMAR (≥ 3 строк). Сообщите врачу при первой возможности.` };
  }
}
