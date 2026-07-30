# Preliminary Trademark Search: SNACK

Search date: **2026-07-30**

Proposed use: `SNACK` as the name of software and a command-line interface.

## Outcome

**Preliminary search result: conflicts require a decision.** This search alone
does not support legal clearance. The official records include live, exact
`SNACK` marks for software and software services in the United States, a live
exact application covering both relevant classes, and live Brazilian marks
containing `SNACK` for software and data-processing/software services.

This report is a limited screening of public government databases, not a legal
clearance opinion and not a conclusion that `SNACK` is available or unavailable.
A qualified trademark attorney should evaluate likelihood of confusion, the
actual goods and channels of trade, common-law use, and filing strategy before
release or filing.

After reviewing these findings on 2026-07-30, the owner chose to retain the name
and accept the identified risk. ADR-0005 records that go/no-go decision, and
`docs/release/identity.md` marks the decision gate passed. The underlying search
findings and limitations remain unchanged.

## Scope And Classification

The search focused on word marks in these Nice classes:

- **Class 9:** downloadable or recorded software and related computer goods.
- **Class 42:** software design and development, SaaS/PaaS, hosted or temporary
  use of non-downloadable software, and related computer services.

INPI states that Brazil uses the Nice Classification and links its official NCL
(13-2026) list on the [INPI classification page][inpi-classification]. USPTO
identifies class 9 as electrical and scientific apparatus and class 42 as
computer, scientific, and legal services; it also treats 9 and 42 as coordinated
classes in federal searching.[^uspto-coordinated]

The proposed product specification has not been finalized. The final filing
classes and descriptions may therefore be broader or narrower than this screen.

## Brazil: INPI

### Method And Exact Queries

The official [INPI pePI trademark database][inpi-search] was entered with the
public anonymous `Continuar` flow. The `Marca` basic-search form was submitted
with the following exact HTTP form values; `registerPerPage=100`,
`Action=searchMarca`, and `tipoPesquisa=BY_MARCA_CLASSIF_BASICA` were used for
every query.

| Search | `buscaExata` | `marca` | `classeInter` | Reported results |
| --- | --- | --- | --- | ---: |
| Exact, class 9 | `sim` | `SNACK` | `009` | 2 |
| Exact, class 42 | `sim` | `SNACK` | `042` | 1 |
| Radical/near, class 9 | `nao` | `SNAC` | `009` | 30 |
| Radical/near, class 42 | `nao` | `SNAC` | `042` | 68 |

The results pages were generated on 2026-07-30 at approximately 01:17 Brazil
time. The detailed records stated that data were updated through RPI 2899 of
2026-07-28.

### Relevant Records

| Mark | INPI process | Status shown | Owner shown | Class and goods/services shown | Official record |
| --- | --- | --- | --- | --- | --- |
| `SNACKTECH` | 829146083 | Registration in force; granted 2009-10-06; stated term through 2029-10-06 | TEKNISA SERVICE LTDA | NCL(9) 09; `SOFTWARE` | [INPI record][inpi-snacktech] |
| `SC SNACKCONTROL` | 825028833 | Registration in force; granted 2007-05-02; stated term through 2027-05-02 | TOTVS LARGE ENTERPRISE TECNOLOGIA S.A. | NCL(8) 42; data-processing/computing services (`SERVICOS DE PROCESSAMENTO DE DADOS (INFORMATICA)`) | [INPI record][inpi-sc-snackcontrol] |
| `SNACKCONTROL` | 821765035 | Registration cancelled ex officio | SNACKCONTROL SISTEMAS LTDA | NCL(8) 42; development, updating, and maintenance of computer programs and IT consulting | [INPI record][inpi-snackcontrol] |
| `SNACK` | 813363969 | Archived | SNACK CONFECCOES LTDA. | Result listed legacy class `25 : 10`; no relevant software goods established | [INPI record][inpi-snack-813363969] |
| `SNACK` | 813364469 | Archived | SNACK CONFECCOES LTDA. | Result listed legacy class `25 : 10`; no relevant software goods established | [INPI record][inpi-snack-813364469] |
| `SNACK` | 818395702 | Archived | AUT-O-MATIK COMERCIO E REPRESENTACOES LTDA | Result listed legacy class `40 : 15`; no relevant software goods established | [INPI record][inpi-snack-818395702] |

The live `SNACKTECH` and `SC SNACKCONTROL` records are the material Brazilian
hits for this preliminary software screen. The cancelled `SNACKCONTROL` record
does not itself establish a live registration, but it remains relevant to a
future common-law/use investigation. No legal conclusion about confusion is
drawn here.

### INPI Guidance And Limitations

INPI's [Basic Trademark Guide][inpi-guide] says a very similar mark cannot be
registered for similar goods or services and recommends a database search for a
similar registered mark because the result **can help** decide whether to file.
That limited description is screening guidance, not a promise of clearance,
registration, or non-infringement. The same guide says exclusivity requires an
INPI registration. This report accordingly treats the pePI result only as a
preliminary search.

Material interface limitations:

- pePI is session- and cookie-dependent. Direct detail links may first require
  entering [pePI][inpi-search] and choosing anonymous `Continuar`.
- The detail page displayed a CAPTCHA prompt while still returning public record
  text. Automated access may therefore become blocked or incomplete at any time.
- The class-filtered result sets included old Brazilian class codes and some
  records whose displayed class did not match a modern Nice 9/42 reading. This
  behavior makes the class filter unsuitable as a completeness guarantee.
- The screen covered `SNACK` and the radical `SNAC` in classes 9 and 42. It did
  not exhaust Portuguese translations, phonetic spellings such as `SNAK`, design
  marks, every coordinated/related class, owner-name searches, Madrid records,
  court disputes, or unregistered use.
- Statuses can change after the stated search date. INPI itself instructs users
  to monitor the weekly RPI; its email/watch feature does not replace consulting
  the RPI.[^inpi-monitor]

## United States: USPTO

### Method And Exact Queries

The official [USPTO Trademark Search system][uspto-search-system] was used. Its
public web application submitted the queries to its official search service, and
selected serials were checked against official USPTO TSDR data.

The exact query strings and counts returned on 2026-07-30 were:

| Query | Purpose | Reported results | Review performed |
| --- | --- | ---: | --- |
| `CM:SNACK` | USPTO-recommended combined-mark knockout form | 3,713 | First 100 returned; exact `SNACK` software records identified |
| `CM:SNACK AND IC:009` | Class 9 screen | 127 | All 127 paginated results retrieved; 8 exact `SNACK`, including 2 live |
| `CM:SNACK AND IC:042` | Class 42 screen | 123 | All 123 paginated results retrieved; 5 exact `SNACK`, including 2 live |
| `CM:/.*snack.*/ AND IC:(009 OR 042)` | Contains/near-mark screen in 9 or 42 | 325 | All 325 paginated results retrieved; selected live close marks reviewed |

USPTO's official guidance uses `CM:` for a combined-mark knockout search and
`CM:/.*term.*/` to expand a search, but explicitly says not to stop at the exact
wording and that no search method is guaranteed to find all conflicts.[^uspto-federal]

### Exact `SNACK` Software Records

| Mark | Serial / registration | Status shown | Current owner shown | Class and goods/services shown | Official record |
| --- | --- | --- | --- | --- | --- |
| `SNACK` | 87690650 / 5502626 | **Live, registered**; Principal Register; Sections 8 and 15 accepted 2025-02-11 | SNACK HOLDINGS NM LLC | IC 009; mobile application software integrating user, store, and product data with virtual and augmented reality | [TSDR record][uspto-87690650] |
| `SNACK` | 90176765 / 6542849 | **Live, registered**; Principal Register; registered 2021-11-02 | SNACK HOLDINGS NM LLC | IC 042; technology consulting in social media | [TSDR record][uspto-90176765] |
| `SNACK` | 90621628 / no registration | **Live application, under examination**; suspension check completed and application remained suspended on 2026-04-23 | Meet Muse Media Inc. | IC 009 downloadable dating/social-content mobile software; IC 042 non-downloadable software for social networking, introductions, and dating; also IC 025 | [TSDR record][uspto-90621628] |
| `SNACK` | 76009514 / 2539308 | Dead, registration cancelled 2008-11-21 | John J. Dreese | IC 009; computer software for designing and analyzing airfoils | [TSDR record][uspto-76009514] |
| `SNACK` | 86161609 / no registration | Dead, abandoned | Mind Pirate, Inc. | IC 009 and 042; AR/VR software, development tools, PaaS, ASP, and SaaS | [TSDR record][uspto-86161609] |

The first three records are enough to keep the preliminary gate pending. A dead
federal record cannot bar registration as a live federal record can, but USPTO
warns that dead records may still identify common-law use and other legal
problems.[^uspto-dead]

### Selected Live Near Marks

This is a risk-focused sample from all 325 rows returned by the near-mark query,
not a representation that every returned mark is legally relevant. The service
returned some duplicate rows.

| Mark | Serial / registration | Status shown | Owner shown | Class and software relationship | Official record |
| --- | --- | --- | --- | --- | --- |
| `SNACKABLE` | 88058465 / 6034532 | Live, registered; Principal Register | AMAZON TECHNOLOGIES, INC. | IC 042; online non-downloadable software processing electronic media into shorter-form content | [TSDR record][uspto-88058465] |
| `SNACKCHAT` | 99404867 / no registration | Live application; opposition pending as of 2026-07-22 | John Collingwood | IC 009 and 042; downloadable and cloud AI software for text-message summarization | [TSDR record][uspto-99404867] |
| `SNACKSHOP` | 98155830 / no registration | Live application; intent-to-use extension granted | Snackshop, LLC | IC 009 and 042; content aggregation/streaming application, SaaS, and PaaS | [TSDR record][uspto-98155830] |
| `SNACKOS` | 97444212 / 7402872 | Live, registered | Not Just Snacks, Inc. DBA Snackpass | IC 009 and 042; downloadable and non-downloadable restaurant ordering software | [TSDR record][uspto-97444212] |
| `SNACKBOARD` | 99852179 / no registration | Live application | SNACKBOARD, LLC | IC 009 and 042; product-review, discovery, search, collection, and social software | [TSDR record][uspto-99852179] |

These marks have differing commercial contexts. Listing them means only that
they warrant review; it is not a likelihood-of-confusion conclusion.

### USPTO Guidance And Limitations

USPTO says a federal database search is only one essential step in a
**comprehensive** clearance search, which uses many sources and can be complex;
it suggests considering a private trademark attorney.[^uspto-federal] Its
[comprehensive-search guidance][uspto-comprehensive] also calls for federal and
state records, the Trademark Official Gazette, domain records, international
databases, and Internet/common-law searching. Most importantly, USPTO says its
database cannot give a clear-cut registration answer and that even no conflicting
live result is no guarantee of registration.[^uspto-next]

Material interface and search limitations:

- Search-result URLs are client-side and session-based; the official system did
  not expose a durable URL containing each query. Durable TSDR record links are
  supplied instead.
- The class 9, class 42, and near-mark result sets were paged through completely.
  Only the first 100 of the 3,713 unfiltered `CM:SNACK` rows were reviewed because
  that knockout query included overwhelmingly unrelated goods; the complete
  class-specific result sets were then reviewed for the stated software scope.
- Class filtering can omit related goods. USPTO specifically warns that goods
  need not share an international class to be related and that narrowing by class
  is risky.[^uspto-classes]
- This screen did not exhaust alternative spellings/pronunciations (`SNAK`,
  `SNAC`, `SNAX`, and others), design codes, translations, all coordinated
  classes, owner/assignment history, TTAB merits, state registrations, domains,
  or common-law use.
- TSDR statuses and ownership can change after 2026-07-30.

## Manual Reverification

### INPI

1. Open the official [pePI search][inpi-search]. Leave login and password blank
   and select anonymous `Continuar`.
2. Choose `Marcas`, then `Marca`.
3. Run `SNACK` with `Exata` and class `009`; repeat with class `042`.
4. Run `SNAC` with `Radical` and class `009`; repeat with class `042`.
5. Repeat radical searches for plausible phonetic variants, including `SNAK` and
   `SNAX`, and repeat without a class filter. Review related classes as advised by
   counsel.
6. Open every relevant result and record the process number, current status,
   owner, Nice class, specification, filing/concession/term dates, and latest RPI.
7. Verify each live candidate in the latest official RPI before any release or
   filing decision.

### USPTO

1. Open the official [Trademark Search system][uspto-search-system], switch to
   Expert mode, and run the four exact query strings recorded above.
2. Repeat with separate spelling and pronunciation queries, including
   `CM:/.*snac.*/`, `CM:/.*snak.*/`, and `CM:/.*snax.*/`; do not rely only on
   classes 9 and 42.
3. Review both live and dead results. For a manageable live screen, deselect the
   dead status filter only after preserving the dead-record review.
4. Open each candidate in TSDR and verify serial/registration number, live/dead
   status, owner, goods/services, filing basis, prosecution, assignments, and any
   TTAB proceeding.
5. Complete the additional official-source and common-law steps described by
   USPTO's [comprehensive clearance guidance][uspto-comprehensive], preferably
   with qualified U.S. trademark counsel.

## Official Sources

- INPI, [Basic Trademark Guide][inpi-guide], especially `Faca a busca`.
- INPI, [Trademark product/service classification][inpi-classification],
  including the official 2026 Nice list.
- INPI, [pePI Industrial Property Search][inpi-search].
- USPTO, [Search our trademark database][uspto-search-page].
- USPTO, [Federal trademark searching][uspto-federal].
- USPTO, [Comprehensive clearance search for similar trademarks][uspto-comprehensive].
- USPTO, [Using coordinated classes in your federal trademark search][uspto-coordinated].
- USPTO, [Trademark Search help][uspto-search-help].
- USPTO, TSDR records linked in the tables above.

[^uspto-coordinated]: USPTO, [Using coordinated classes][uspto-coordinated], lists class 42 among class 9's coordinated international classes.
[^uspto-federal]: USPTO, [Federal trademark searching][uspto-federal], `Federal trademark searching`, `What to search for`, and `Common search strategies`.
[^inpi-monitor]: INPI, [Basic Trademark Guide][inpi-guide], `Acompanhe`.
[^uspto-dead]: USPTO, [Federal trademark searching][uspto-federal], `Focus mainly on live trademarks`.
[^uspto-next]: USPTO, [Federal trademark searching][uspto-federal], `What happens next` and `No conflicting trademarks`.
[^uspto-classes]: USPTO, [Federal trademark searching][uspto-federal], `Only narrow by goods or services if absolutely necessary`.

[inpi-guide]: https://www.gov.br/inpi/pt-br/servicos/marcas/guia-basico/guia-basico
[inpi-classification]: https://www.gov.br/inpi/pt-br/servicos/marcas/classificacao-marcas/classificacao
[inpi-search]: https://busca.inpi.gov.br/pePI/
[inpi-snacktech]: https://busca.inpi.gov.br/pePI/servlet/MarcasServletController?Action=detail&CodPedido=2027336
[inpi-sc-snackcontrol]: https://busca.inpi.gov.br/pePI/servlet/MarcasServletController?Action=detail&CodPedido=1560084
[inpi-snackcontrol]: https://busca.inpi.gov.br/pePI/servlet/MarcasServletController?Action=detail&CodPedido=1190874
[inpi-snack-813363969]: https://busca.inpi.gov.br/pePI/servlet/MarcasServletController?Action=detail&CodPedido=342850
[inpi-snack-813364469]: https://busca.inpi.gov.br/pePI/servlet/MarcasServletController?Action=detail&CodPedido=342888
[inpi-snack-818395702]: https://busca.inpi.gov.br/pePI/servlet/MarcasServletController?Action=detail&CodPedido=839463
[uspto-search-page]: https://www.uspto.gov/trademarks/search
[uspto-search-system]: https://tmsearch.uspto.gov/
[uspto-search-help]: https://tmsearch.uspto.gov/?page=help
[uspto-federal]: https://www.uspto.gov/trademarks/search/federal-trademark-searching
[uspto-comprehensive]: https://www.uspto.gov/trademarks/search/comprehensive-clearance-search-similar-trademarks
[uspto-coordinated]: https://www.uspto.gov/trademarks/search/using-coordinated-classes-your-federal-trademark-search
[uspto-87690650]: https://tsdr.uspto.gov/#caseNumber=87690650&caseSearchType=US_APPLICATION&caseType=DEFAULT&searchType=statusSearch
[uspto-90176765]: https://tsdr.uspto.gov/#caseNumber=90176765&caseSearchType=US_APPLICATION&caseType=DEFAULT&searchType=statusSearch
[uspto-90621628]: https://tsdr.uspto.gov/#caseNumber=90621628&caseSearchType=US_APPLICATION&caseType=DEFAULT&searchType=statusSearch
[uspto-76009514]: https://tsdr.uspto.gov/#caseNumber=76009514&caseSearchType=US_APPLICATION&caseType=DEFAULT&searchType=statusSearch
[uspto-86161609]: https://tsdr.uspto.gov/#caseNumber=86161609&caseSearchType=US_APPLICATION&caseType=DEFAULT&searchType=statusSearch
[uspto-88058465]: https://tsdr.uspto.gov/#caseNumber=88058465&caseSearchType=US_APPLICATION&caseType=DEFAULT&searchType=statusSearch
[uspto-99404867]: https://tsdr.uspto.gov/#caseNumber=99404867&caseSearchType=US_APPLICATION&caseType=DEFAULT&searchType=statusSearch
[uspto-98155830]: https://tsdr.uspto.gov/#caseNumber=98155830&caseSearchType=US_APPLICATION&caseType=DEFAULT&searchType=statusSearch
[uspto-97444212]: https://tsdr.uspto.gov/#caseNumber=97444212&caseSearchType=US_APPLICATION&caseType=DEFAULT&searchType=statusSearch
[uspto-99852179]: https://tsdr.uspto.gov/#caseNumber=99852179&caseSearchType=US_APPLICATION&caseType=DEFAULT&searchType=statusSearch
