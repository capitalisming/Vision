// AI-assisted (Claude Code), reviewed by a team member.
// "Why this test": the reason for the app, from NASA sources. Every number below was read from the source it
// cites (NASA Human Research Roadmap page, Mader et al. 2011 abstract via Europe PMC) on 15 Nov 2026.
// Keep the wording in step with the sources; do not add figures that are not in them.

export const SOURCES = [
  {
    id: 1,
    text: 'NASA Human Research Program. Risk of Spaceflight Associated Neuro-ocular Syndrome (SANS). Human Research Roadmap.',
    url: 'https://humanresearchroadmap.nasa.gov/risks/risk.aspx?i=105',
  },
  {
    id: 2,
    text: 'Mader TH, Gibson CR, Pass AF, et al. Optic disc edema, globe flattening, choroidal folds, and hyperopic shifts '
      + 'observed in astronauts after long-duration space flight. Ophthalmology. 2011;118(10):2058-2069. '
      + 'doi:10.1016/j.ophtha.2011.06.021',
    url: 'https://doi.org/10.1016/j.ophtha.2011.06.021',
  },
];

export const WHY_THIS_TEST = [
  'Long missions change the eye. NASA tracks this as the Risk of Spaceflight Associated Neuro-ocular Syndrome (SANS). '
    + 'About 70% of crew show at least one of its signs, and one of them is a hyperopic shift: the focus of the eye '
    + 'moves, so close-up objects get harder to see [1].',
  'After six-month missions to the International Space Station, 6 of 7 astronauts who were examined had worse near '
    + 'vision. Five of the seven with near-vision complaints had a hyperopic shift of +0.50 to +1.75 diopters. In a '
    + 'survey of 300 astronauts, about 29% after short missions and 60% after long ones reported worse distant and '
    + 'near vision [2].',
  'That is why this test checks near vision at 40 cm when the screen is sharp enough to show good eyes a result there, '
    + 'and at 1 m otherwise. It compares each result with your own baseline, '
    + 'without an eye doctor on board, and tells you when it is worse twice in a row. It is a pilot prototype that '
    + 'monitors functional vision change; it does not measure diopters.',
];

/** The "Why this test" section as a <details> element, with clickable sources. */
export function whyThisTestElement(doc = document) {
  const details = doc.createElement('details');
  details.className = 'why';
  const summary = doc.createElement('summary');
  summary.textContent = 'Why this test';
  details.append(summary);
  for (const text of WHY_THIS_TEST) details.append(Object.assign(doc.createElement('p'), { textContent: text }));
  const list = doc.createElement('ol');
  list.className = 'why-sources';
  for (const s of SOURCES) {
    const li = doc.createElement('li');
    const link = Object.assign(doc.createElement('a'), { href: s.url, textContent: s.text, target: '_blank', rel: 'noopener' });
    li.append(link);
    list.append(li);
  }
  details.append(list);
  return details;
}
