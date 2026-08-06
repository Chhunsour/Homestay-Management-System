# Homestay SaaS design system

This is the visual source of truth for the web dashboard and Expo app. It changes presentation only; business rules, data contracts, permissions, and navigation destinations remain unchanged.

## Direction

The product should feel like a calm, capable Cambodian hospitality desk: rain-washed greens, clean paper surfaces, warm roof-tile accents, and clear operational hierarchy. Avoid generic fintech blue, neon gradients, glass effects, and repetitive bordered cards.

The signature element is the roof marker: a short orange rule used once beside the primary title on each screen. Spend visual emphasis there and keep the rest disciplined.

## Tokens

| Role | Web | Mobile | Use |
| --- | --- | --- | --- |
| Brand dark | `#182D22` | `colors.brandDark` | Primary actions, featured metrics, navigation |
| Brand | `#2E543E` | `colors.brand` | Active states and focus |
| Brand soft | `#E2EBE4` | `colors.brandSoft` | Selected and supporting surfaces |
| Accent | `#C8783A` | `colors.accent` | Roof marker and sparse emphasis only |
| Canvas | `#F2F5F0` | `colors.canvas` | App background |
| Surface | `#FCFDFB` | `colors.surface` | Cards, forms, navigation |
| Text | `#18231D` | `colors.text` | Primary text |
| Muted text | `#526057` | `colors.muted` | Secondary text; must retain AA contrast |
| Line | `#DCE4DC` | `colors.line` | Dividers and form borders |
| Danger | `#A83D3D` | `colors.danger` | Errors and destructive actions |

Use one accent per screen. Status colors may remain data-driven, but always pair color with a text label or count.

## Typography

- Web display: Newsreader 500–600 for the brand, page titles, large metrics, and section titles.
- Web body: DM Sans 400–700, with Noto Sans Khmer as the Khmer face.
- Mobile: native system type for reliable Dynamic Type; use size and weight to mirror the web hierarchy.
- Page title: 30–40px web, 30px mobile, tight tracking, compact line-height.
- Body: 14–16px with at least 1.5 line-height.
- Numbers: tabular figures for money and operational totals.

## Layout

- Desktop: 272px persistent navigation rail and a content canvas capped at 1472px.
- Tablet: preserve content order and collapse asymmetric grids before they become cramped.
- Mobile web: horizontal route navigation with no hidden destination.
- Native: safe-area-aware scroll views, 20px gutters, 4/8-point rhythm, and a 760px content cap for tablets.
- Dashboard metrics are intentionally asymmetric: money owed receives the strongest emphasis.

## Components

- Cards: 16–18px outer radius, paper surface, tinted low elevation; borders only when they communicate structure.
- Inputs: minimum 44px web / 52px native, persistent labels, 12–14px radius, visible focus/error state.
- Buttons: minimum 44px, 14px radius, one primary action per context, stable pressed feedback.
- Navigation: icon plus text label, clear active state, 44px minimum target.
- Empty states: a small roof marker, plain explanation, and an action only when a real action exists.
- Tables: quiet header, tabular data, row hover on web, horizontal containment only when unavoidable.

## Motion

Use 150–250ms transitions for hover, press, and focus. Animate opacity and transform only. Respect reduced motion. Do not add decorative page-load choreography to operational screens.

## Accessibility and delivery gates

- WCAG AA contrast for text and controls.
- Keyboard-visible focus on all web interactions.
- At least 44x44pt touch targets and 8px separation on native.
- No emoji as structural icons; use the shared vector icon language.
- Do not rely on color alone for status.
- Verify web at 375, 768, 1024, and 1440px.
- Verify native at small phone, large phone, and tablet widths with Dynamic Type.
- No content behind sticky navigation or safe-area edges.
- No backend, schema, action, query, permission, or feature changes as part of visual work.
