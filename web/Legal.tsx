import React from "react";

/**
 * Static legal & support surface — PRODUCTION_PLAN #10.
 *
 * These are four documents the plan calls for (terms, privacy, support,
 * refund/cancellation) plus the shared shell that makes them reachable while
 * signed out.
 *
 * STATUS — read before editing:
 *   The wording below is complete and accurate about what the product does,
 *   but it has **not** been reviewed by counsel. That review is the stated
 *   acceptance criterion for #10 and must happen before a paid pilot. Two
 *   things are deliberately left unstated because this file cannot know them:
 *   the contracting legal entity, and the governing-law jurisdiction. Whoever
 *   holds the review supplies both.
 *
 * Reachability is enforced, not assumed: `isLegalPath()` is the same list the
 * server's `SPA_LINK_PATHS` allowlist mirrors, so a deep link to `/privacy`
 * serves the shell instead of 404ing. `server/legal.pages.integration.test.ts`
 * asserts the two stay in step.
 */

/**
 * The four public documents. Each declares its own path, and the runtime
 * allowlist below is derived from this array — so a document cannot exist
 * without a path, and a path cannot be advertised without a document.
 */
export type LegalPath = "/terms" | "/privacy" | "/support" | "/refunds";

type Section = {
  heading: string;
  paragraphs?: string[];
  bullets?: string[];
};

type Document = {
  path: LegalPath;
  nav: string;
  title: string;
  intro: string;
  sections: Section[];
};

/**
 * Shared with the landing page's "Book a demo" link, which already ships this
 * reserved `.example` address. Replace both with the real contact address
 * before launch (tracked under PRODUCTION_PLAN #10).
 */
export const CONTACT_EMAIL = "hello@northline.example";

const UPDATED = "27 September 2026";

const DOCUMENTS: Document[] = [
  {
    path: "/terms",
    nav: "Terms of Service",
    title: "Terms of Service",
    intro:
      "These terms govern your access to and use of Northline, the hosted workspace for managing construction projects, workforce attendance, materials, expenses and site issues. Creating a workspace, accepting an invitation, or using the service means you accept them.",
    sections: [
      {
        heading: "1. Who these terms are between",
        paragraphs: [
          'These terms are between you and the entity that operates the Northline service for your workspace ("Northline", "we" or "us"). "You" means the individual accepting them and, where you use Northline for an organisation, that organisation as well.',
          "By registering, accepting an invitation, or continuing to use the service you confirm that you have read these terms and, where you act for an organisation, that you have authority to bind it. If you do not have that authority, or do not agree, do not use the service.",
        ],
      },
      {
        heading: "2. What the service is",
        paragraphs: [
          "Northline is a hosted software application for running construction operations: projects and budgets, worker attendance, material movement, expenses, safety issue reporting, invitations and role-based access, and subscription billing.",
        ],
        bullets: [
          "We may improve or change the service over time. If we plan to remove or materially reduce functionality you have paid for, we will give you notice so you can export your data or cancel.",
          "Availability commitments, if any, are those stated in a separate service level agreement. None is promised by these terms alone.",
        ],
      },
      {
        heading: "3. Accounts and workspace access",
        paragraphs: [
          "You need an account to use Northline. Registration requires a working email address so we can send verification, password reset and invitation messages. Give accurate information and keep it current.",
        ],
        bullets: [
          "Keep your password confidential. You are responsible for activity that happens under your account.",
          "Your workspace administrator controls who joins, which role they hold, and what that role can see. Contact them first for access changes, removal, or data questions inside the workspace.",
          "Tell us promptly if you believe your account or credentials have been compromised so we can help contain it.",
          "We will never ask you for your password, and password recovery only ever happens through the emailed reset link.",
        ],
      },
      {
        heading: "4. Acceptable use",
        paragraphs: [
          "You agree not to misuse Northline. In particular, you will not:",
        ],
        bullets: [
          "use the service for anything unlawful, fraudulent, or infringing of another person's rights;",
          "attempt to access data you are not authorised for, probe or scan the service, or bypass access controls, rate limits or security measures;",
          "introduce malware, overload the service, or interfere with other workspaces;",
          "reverse engineer or resell the service except where applicable law expressly permits or we agree in writing;",
          "record personal data about people you have no lawful basis to process.",
          "Enter safety-critical site data — structural, engineering, or statutory safety records — into the workspace only alongside your own verification. Northline is a management and reporting tool, not a system of record for engineering sign-off.",
        ],
      },
      {
        heading: "5. Your data",
        paragraphs: [
          "You keep ownership of everything you and your workspace members put into Northline: projects, attendance records, materials, expenses, safety reports, notes and attachments.",
          "You give us a licence to host, copy, process and display that data solely to operate and support the service for you — serving it to your authorised members, generating the views and reports you ask for, and backing it up.",
          "You are responsible for having a lawful basis to enter that data, including personal data about your workers. Where attendance or site records concern identifiable people, you must have told them how those records are used.",
          "We do not sell your data, and we do not use your workspace content to train anything or to advertise to you.",
        ],
      },
      {
        heading: "6. Paid plans, fees and billing",
        paragraphs: [
          "Northline is free within published plan limits, with paid plans billed through our payment processor. Prices, plan limits and the billing period are shown before you confirm a purchase.",
        ],
        bullets: [
          "Paid subscriptions renew automatically at the end of each billing period until you cancel.",
          "You are responsible for applicable taxes, which are added where required.",
          "If a free trial converts to a paid plan, we tell you what happens and when before charging you.",
          "If we change pricing, we give notice before the change takes effect on your next renewal. Continuing to renew means you accept the new price.",
          "We may change plan limits; if a change would break how you use the service we will tell you first.",
        ],
      },
      {
        heading: "7. Cancellation, refunds and termination",
        paragraphs: [
          "You can cancel at any time from the billing panel in your workspace. Cancellation, refunds and what happens to your data afterwards are covered by our Refund and Cancellation Policy, which forms part of these terms.",
          "You can stop using Northline at any time. We may suspend or end access if you materially breach these terms, if payment remains overdue after notice, or if continued service would create a security or legal risk. Where the situation is fixable, we will tell you what is wrong and give you a chance to fix it.",
        ],
      },
      {
        heading: "8. Our intellectual property",
        paragraphs: [
          "We own Northline — the software, interface, documentation and everything about them other than your data. Nothing in these terms transfers our intellectual property to you.",
          "If you send us feedback or suggestions, we may use them without obligation or payment to you.",
        ],
      },
      {
        heading: "9. Disclaimers",
        paragraphs: [
          'The service is provided "as is" and "as available". To the extent permitted by law we make no warranty that it will be uninterrupted, error-free, or suitable for every purpose, and we are not responsible for data you lose through your own failure to keep exports.',
          "Northline records what your team enters. It does not verify structural calculations, replace professional engineering judgement, satisfy statutory site records on its own, or guarantee that an issue has been made safe because it is marked resolved.",
          "Nothing in these terms excludes a warranty or right that applicable law does not allow us to exclude.",
        ],
      },
      {
        heading: "10. Limitation of liability",
        paragraphs: [
          "To the extent permitted by law, neither party is liable for indirect, incidental, special, or consequential loss, or for lost profits, lost data, or lost business opportunity arising out of these terms.",
          "Our total liability for claims arising from the service is limited to the amount you paid Northline in the 12 months before the event giving rise to the claim. If you were on a free plan during that period, the limit is the greater of that amount and 100 in your currency.",
          "These limits do not apply to anything that cannot be limited by law, including liability for death or personal injury caused by negligence, fraud, or fraudulent misrepresentation.",
          "You are responsible for the consequences of decisions taken on the basis of workspace records, and for keeping your own statutory and engineering records.",
        ],
      },
      {
        heading: "11. Changes to these terms",
        paragraphs: [
          "When we update these terms we change the date at the top of the page, and for material changes we notify workspace administrators before they take effect. Continued use after that point means you accept the update.",
        ],
      },
      {
        heading: "12. Contact",
        paragraphs: [
          `Questions about these terms go to ${CONTACT_EMAIL}. Support requests, including the information we need to investigate one, are described on the Support page.`,
        ],
      },
    ],
  },
  {
    path: "/privacy",
    nav: "Privacy Policy",
    title: "Privacy Policy",
    intro:
      "This policy explains what personal data Northline collects, why we collect it, who we share it with, how long we keep it, and the choices you have. It covers the hosted service only — sites we link to have their own policies.",
    sections: [
      {
        heading: "1. What we collect",
        paragraphs: ["Northline collects the following categories of data:"],
        bullets: [
          "Account and profile data — your name, email address, optional phone number, your company name and company email. We also store a salted hash of your password; never the password itself.",
          "Workspace content — the projects, budgets, attendance check-in and check-out records, materials, expenses, safety issue reports, notes, and audit entries your team creates.",
          "Invitation data — the email address an administrator invites, the role offered, and a time-limited invitation token.",
          "Technical and log data — IP address, browser user agent, request timestamps, a request identifier attached to every request for tracing, and diagnostic information from errors.",
          "Subscription data — plan, status, and billing period. Card numbers are held by our payment processor; we receive confirmation and limited card details such as the last four digits, not the full number.",
        ],
      },
      {
        heading: "2. How we use it",
        bullets: [
          "To provide the workspace: authenticating you, enforcing your role's permissions, and showing you the data your workspace shares with you.",
          "To send transactional email — account verification, password reset, and workspace invitations — through a dedicated email delivery provider. These messages are part of the service, not marketing; we do not send marketing email.",
          "To bill you, apply plan limits, and prevent payment fraud.",
          "To keep the service secure: rate limiting sign-in attempts, recording an audit trail of privileged actions, and detecting abuse or unauthorised access.",
          "To diagnose faults: correlating an error you report with the server-side record using the request identifier.",
          "To answer support requests you send us.",
        ],
      },
      {
        heading: "3. Cookies and similar storage",
        paragraphs: [
          "Northline uses a single essential session cookie to keep you signed in. It is marked httpOnly (so page scripts cannot read it), set to the strictest practical same-site policy, and marked Secure whenever the service runs over HTTPS. Without it you would have to authenticate on every request.",
          "We do not use advertising cookies, cross-site tracking, or analytics cookies that follow you to other sites.",
        ],
      },
      {
        heading: "4. Our legal bases",
        bullets: [
          "Performing our contract with you — providing the workspace and sending the transactional messages the service depends on.",
          "Legitimate interests — securing the service, preventing abuse, understanding aggregate reliability, and answering support requests.",
          "Consent — for anything optional, such as the optional phone field, which you can leave blank.",
          "Legal obligation — retaining records where the law requires it.",
        ],
      },
      {
        heading: "5. Who we share it with",
        paragraphs: [
          "We share personal data only with service providers that process it on our behalf, under contracts that limit them to that purpose, and with authorities where the law requires it.",
        ],
        bullets: [
          "Infrastructure — the hosting and database provider that stores your workspace.",
          "Email delivery — our transactional email provider receives the recipient address and message content for verification, reset and invitation emails.",
          "Payment processing — our payment processor handles card details and payment confirmations.",
          "Error monitoring — when configured, an error tracking service receives diagnostic reports so we can fix faults. These are configured without session cookies or replay of your content.",
          "We do not sell personal data, and we do not share your workspace content with other customers or use it for advertising.",
        ],
      },
      {
        heading: "6. International transfers",
        paragraphs: [
          "Data may be processed in countries other than the one you live in, because we and our providers operate internationally. Where the law requires safeguards for such transfers, we use the mechanisms it provides — such as standard contractual clauses — and we only use providers that commit to adequate protection.",
        ],
      },
      {
        heading: "7. Retention and deletion",
        bullets: [
          "Workspace content is kept for as long as your workspace exists, because that is what the service is for.",
          "When you or your administrator removes a person, we delete or de-identify their profile details within a reasonable period, subject to any record we must keep by law.",
          "Audit and security records are kept for a limited period and then removed, so we can investigate incidents that come to light later without keeping them indefinitely.",
          "Backups age out on their own schedule; a deletion may therefore take until the next backup cycle to disappear from archived copies.",
        ],
      },
      {
        heading: "8. Security",
        paragraphs: [
          "We apply the controls that the codebase is built around rather than promising more:",
        ],
        bullets: [
          "Passwords stored only as salted hashes, never in readable form.",
          "Encrypted transport in production, with secure, httpOnly session cookies.",
          "Role-based access so a person only sees what their role allows, enforced server-side rather than hidden in the interface.",
          "An audit trail of privileged actions, visible to workspace administrators.",
          "Rate limiting on authentication endpoints to slow credential guessing.",
          "A request identifier on every request so an incident can be traced end to end.",
          "Secrets supplied through the environment, never written into the application bundle.",
        ],
      },
      {
        heading: "9. Your rights",
        paragraphs: [
          "Depending on where you live, you may have rights to access, correct, delete, export, restrict, or object to our use of your personal data, and to withdraw consent where processing relies on it.",
          "Most of your data lives inside your workspace, so your administrator can view or correct much of it directly. For anything else, contact us at the address below and we will act on a verified request within the time your law allows. You may also complain to your data protection authority.",
        ],
      },
      {
        heading: "10. Children",
        paragraphs: [
          "Northline is a business service for managing construction operations. It is not directed at children, and we do not knowingly collect personal data from anyone below the minimum working age in their jurisdiction.",
        ],
      },
      {
        heading: "11. Changes and contact",
        paragraphs: [
          `We update this policy when our practices change, and we date every version. Material changes are announced to workspace administrators. Questions, requests, and concerns go to ${CONTACT_EMAIL}.`,
        ],
      },
    ],
  },
  {
    path: "/support",
    nav: "Support",
    title: "Support and contact",
    intro:
      "How to reach us, what to include so we can actually fix the problem, what we can and cannot do, and how to report a security issue safely.",
    sections: [
      {
        heading: "1. Getting help",
        paragraphs: [
          `Email ${CONTACT_EMAIL}. That is the fastest route for anything you cannot resolve in the workspace.`,
          "Most day-to-day access questions belong with your workspace administrator, not us — they can invite people, assign and change roles, revoke invitations, and see your audit trail from the Admin and audit section.",
        ],
      },
      {
        heading: "2. What to include",
        paragraphs: ["A report we can act on on the first pass includes:"],
        bullets: [
          "The workspace or company name and the email address on your account.",
          "What you were doing, what you expected, and what happened instead.",
          "The exact time of the failure, with your time zone.",
          "The X-Request-ID from the failed response. Your browser shows it in the developer tools under the Network tab; it ties your report to the precise server-side log entry, which turns a guess into a diagnosis.",
          "Screenshots where they help — with any personal data you are not comfortable sharing already removed.",
        ],
      },
      {
        heading: "3. What we can and cannot do",
        bullets: [
          "We can send a password reset to your email address, explain an error, and investigate anything failing on our side.",
          "We cannot recover a forgotten password for you — reset it yourself from the sign-in screen. That is deliberate: it means no one, including us, can read your password.",
          "We cannot change what your role permits, bypass an administrator's decision, or hand one member another member's data. Those changes come from your workspace administrator.",
          "We cannot restore a workspace to an earlier point on demand. Retention is covered in the Privacy Policy.",
        ],
      },
      {
        heading: "4. Response times",
        paragraphs: [
          "We aim to acknowledge reports within one business day and to come back with a substantive answer within two business days. Security reports are acknowledged within 24 hours.",
          "These are targets rather than a contractual commitment unless a service level agreement says otherwise. Incidents affecting availability are published where one exists.",
        ],
      },
      {
        heading: "5. Reporting a security issue",
        paragraphs: [
          `Email ${CONTACT_EMAIL} with the subject "Security report". Describe what you found, what it exposes, and how to reproduce it.`,
        ],
        bullets: [
          "Do not include real customer data, credentials, or personal information in your report.",
          "Do not access data that is not yours, or disrupt the service to prove a point — a description of the path is enough.",
          "Give us a reasonable window to fix the issue before publishing it.",
          "We will acknowledge the report, keep you updated, and credit you if you want to be named.",
        ],
      },
      {
        heading: "6. Billing and cancellation questions",
        paragraphs: [
          "Plan changes, cancellation and refunds are handled in your workspace under Billing, and the Refund and Cancellation Policy explains exactly what happens. If something about a charge looks wrong, email us with the date and amount and we will look at it.",
        ],
      },
    ],
  },
  {
    path: "/refunds",
    nav: "Refunds and cancellation",
    title: "Refund and Cancellation Policy",
    intro:
      "How to cancel a paid plan, when cancellation takes effect, when refunds are given, and what happens to your data afterwards. This policy forms part of the Terms of Service.",
    sections: [
      {
        heading: "1. How to cancel",
        paragraphs: [
          "Open Billing in your workspace and use Manage billing. Cancellation runs through the payment portal attached to your account, so you can do it yourself at any time without contacting anyone.",
          "Only a workspace administrator can change or cancel a paid subscription.",
        ],
      },
      {
        heading: "2. When cancellation takes effect",
        bullets: [
          "Cancelling stops the next renewal. It does not refund the current period.",
          "You keep full access until the end of the period you already paid for, so nothing is cut off mid-month.",
          "If the subscription was set to cancel at period end already, the Billing panel shows that date — cancellation is scheduled rather than pending.",
          "When the period ends the workspace moves to the free plan. Plan limits then apply, and features above them become unavailable rather than deleted.",
        ],
      },
      {
        heading: "3. Trials",
        paragraphs: [
          "A free trial runs for the period stated when you start it. If payment details were required to begin the trial, we tell you what the plan costs and when charging starts before you confirm. If you cancel before that point you are not charged.",
        ],
      },
      {
        heading: "4. When we refund",
        paragraphs: [
          "We refund in good faith, and we always refund where the law says we must:",
        ],
        bullets: [
          "A charge taken in error, a duplicated charge, or a plan you never selected — refunded to the original payment method, usually within a few business days of us confirming it.",
          "A significant outage or defect that made the service unusable for a substantial part of a paid period — a credit or a refund for that period, whichever fits better.",
          "Where you are a consumer and applicable law gives you a right of withdrawal or a statutory refund, that right applies in full and nothing here reduces it.",
          "If our pricing or plan description was wrong at the moment you bought, we honour the correct one or refund you.",
        ],
      },
      {
        heading: "5. When we do not refund",
        bullets: [
          "Change of mind partway through a billing period you have already used.",
          "Downgrading or removing users after the renewal date.",
          "Inactivity, or because a team member did not adopt the tool.",
          "Suspension caused by your breach of the Terms of Service or by payment remaining overdue.",
        ],
      },
      {
        heading: "6. Payment problems",
        paragraphs: [
          "If a payment fails, we retry it and notify the workspace administrator. Repeated failures can leave the subscription past due, and continued non-payment may lead to suspension after notice. Fixing the payment method in the billing portal restores service.",
        ],
      },
      {
        heading: "7. Your data after you cancel",
        bullets: [
          "Export what you need while you still have access — cancellation does not delete your workspace at the end of the period.",
          "After the workspace moves to the free plan, your data stays put under the free plan's limits so you can keep working or change your mind.",
          "If you want the workspace and its data deleted entirely, contact us. We action a verified deletion request within the period applicable law requires, and backups age out on their own schedule as described in the Privacy Policy.",
        ],
      },
      {
        heading: "8. Questions",
        paragraphs: [
          `If any of this is unclear, or a charge needs reviewing, email ${CONTACT_EMAIL} with the workspace name, the charge date and the amount.`,
        ],
      },
    ],
  },
];

/** Derived from the documents above — the single source of truth. */
export const LEGAL_PATHS: readonly LegalPath[] = DOCUMENTS.map(
  (doc) => doc.path,
);

export function isLegalPath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/";
  return (LEGAL_PATHS as readonly string[]).includes(path);
}

function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function Legal({ path }: { path: string }) {
  const doc = DOCUMENTS.find((item) => item.path === path);
  return (
    <main className="legal-shell">
      <nav className="landing-nav">
        <a className="brand" href="/">
          NORTHLINE
        </a>
        <span className="muted">Legal, privacy and support</span>
        <a href="/">Back to the app</a>
      </nav>
      <div className="legal-layout">
        <aside className="legal-nav" aria-label="Legal documents">
          {DOCUMENTS.map((item) => (
            <a
              key={item.path}
              href={item.path}
              className={item.path === path ? "active" : ""}
            >
              {item.nav}
            </a>
          ))}
        </aside>
        <article className="legal-doc">
          {doc ? (
            <>
              <p className="kicker">Legal &amp; support</p>
              <h1>{doc.title}</h1>
              <p className="muted legal-updated">Last updated {UPDATED}</p>
              <p className="legal-intro">{doc.intro}</p>
              {doc.sections.map((section) => (
                <section key={section.heading} id={slugify(section.heading)}>
                  <h2>{section.heading}</h2>
                  {section.paragraphs?.map((paragraph) => (
                    <p key={paragraph}>{paragraph}</p>
                  ))}
                  {section.bullets && (
                    <ul>
                      {section.bullets.map((bullet) => (
                        <li key={bullet}>{bullet}</li>
                      ))}
                    </ul>
                  )}
                </section>
              ))}
              <footer className="legal-footer">
                <a href="/terms">Terms</a>
                <a href="/privacy">Privacy</a>
                <a href="/support">Support</a>
                <a href="/refunds">Refunds</a>
                <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
              </footer>
            </>
          ) : (
            <>
              <h1>Page not found</h1>
              <p className="legal-intro">
                That document does not exist. Use the list alongside to reach
                the terms, privacy policy, support page or refund policy.
              </p>
            </>
          )}
        </article>
      </div>
    </main>
  );
}
