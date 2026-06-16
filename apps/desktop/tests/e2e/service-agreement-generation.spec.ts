import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { mockGateway, mockGatewaySurfaces, mockTauri, type TauriMockSettings } from './_helpers';

const SOURCE_PDF = process.env.IRONCLAW_SERVICE_TEMPLATE_PDF ?? '';
const EXPORT_OUT = process.env.IRONCLAW_SERVICE_EXPORT_OUT ?? '';
const HAS_REAL_SOURCE_PDF = SOURCE_PDF !== '' && existsSync(SOURCE_PDF);

const SETTINGS: TauriMockSettings = {
  activeProfileId: 'default',
  profiles: [
    {
      id: 'default',
      name: 'Default',
      mode: 'remote',
      remoteBaseUrl: 'http://127.0.0.1:18789',
      localBaseUrl: 'http://127.0.0.1:3100',
      llmBackend: 'nearai',
      llmProviderId: 'nearai'
    }
  ],
  onboardingComplete: true,
  adminMode: false,
  trayEnabled: true,
  useResponsesApi: false,
  engineV2Enabled: false
};

const DUMMY_TEMPLATE_PDF = Buffer.from(
  [
    '%PDF-1.4',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >> endobj',
    '4 0 obj << /Length 95 >> stream',
    'BT /F1 12 Tf 72 720 Td (Detailed services agreement template with clause coverage.) Tj ET',
    'endstream endobj',
    'xref',
    '0 5',
    '0000000000 65535 f ',
    'trailer << /Root 1 0 R >>',
    '%%EOF'
  ].join('\n')
);

const GENERATED_AGREEMENT = `# Services Agreement

This Services Agreement is entered into by and between Atlas Harbor Analytics, Inc., a Delaware corporation ("Customer"), and Northstar Forge Labs Ltd., a company incorporated in England and Wales ("Service Provider").

## Recitals

A. Customer operates analytics products for logistics teams.

B. Service Provider provides software implementation, workflow automation, and integration services.

C. Customer wishes to engage Service Provider to configure a chief-of-staff workspace automation layer using Customer-approved connectors and approval-gated workflows.

## 1. Definitions

"Acceptance Criteria" means the functional requirements, security requirements, and handoff materials described in Schedule 1.

"Customer Data" means data, files, messages, calendar data, notes, prompts, outputs, credentials, and metadata made available by Customer.

"Deliverables" means project plans, configurations, workflow definitions, documentation, training materials, reports, and other work product created specifically for Customer.

## 2. Services

Service Provider will provide discovery, connector implementation, workflow design, testing, documentation, administrator training, and post-launch support as described in Schedule 1.

Service Provider will perform the Services in a professional and workmanlike manner using personnel with appropriate skill and experience.

Service Provider will not activate production connectors, external sends, external writes, deletions, exports, or filing workflows without Customer approval.

## 3. Project Management

Each party will appoint a project lead. The project leads will meet weekly during implementation and will maintain a delivery tracker.

Customer will provide timely access to relevant personnel, approved test accounts, non-production workspace data, and feedback on submitted Deliverables.

Delays caused by Customer dependencies will extend impacted milestones by the length of the delay plus a reasonable restart period.

## 4. Fees and Payment

Customer will pay USD 95,000 in milestone fees: USD 12,500 at kickoff, USD 27,500 after connector build, USD 35,000 after workflow launch, and USD 20,000 after enablement.

Invoices are due net thirty days from receipt unless disputed in good faith. Undisputed late amounts may accrue interest at one percent per month or the maximum amount allowed by law.

Customer will reimburse pre-approved travel and out-of-pocket expenses at cost without markup.

## 5. Acceptance

Service Provider will submit each Deliverable for acceptance. Customer will review each Deliverable within five business days.

If Customer rejects a Deliverable, Customer will describe the nonconformity in reasonable detail. Service Provider will correct the nonconformity and resubmit the Deliverable.

A Deliverable is accepted when Customer approves it in writing, uses it in production, or does not reject it within the review period.

## 6. Term and Termination

The Agreement starts on the last signature date and continues for twelve months unless terminated earlier under the Agreement.

Either party may terminate for material breach if the breach is not cured within thirty days after written notice.

Customer may terminate for convenience on thirty days written notice. Customer will pay for Services performed and non-cancellable commitments incurred before the termination date.

## 7. Customer Data and Security

Customer Data will be processed only to provide the Services and support the Deliverables.

Provider will not train models on Customer Data.

Service Provider will maintain administrative, technical, and organizational safeguards designed to protect Customer Data from unauthorized access, disclosure, alteration, and destruction.

Service Provider will promptly notify Customer of a confirmed security incident affecting Customer Data and will cooperate in remediation.

## 8. Confidentiality

Each party may receive non-public information from the other party. The receiving party will use Confidential Information only to perform or receive the Services.

The receiving party will protect Confidential Information using at least reasonable care and will not disclose it except to personnel and advisors with a need to know.

Confidentiality obligations do not apply to information that is public through no fault of the receiving party, independently developed, or rightfully received from a third party.

## 9. Intellectual Property

Customer owns custom Deliverables after full payment, excluding Service Provider background IP, open-source software, and third-party materials.

Service Provider retains ownership of pre-existing tools, templates, know-how, libraries, workflows, and generalized improvements that do not contain Customer Confidential Information.

Customer receives a perpetual, worldwide, non-exclusive license to use Service Provider background IP incorporated into Deliverables solely with the Deliverables.

## 10. Third-Party Services

Customer is responsible for its third-party workspace accounts, connector permissions, and third-party service terms.

Service Provider is not responsible for third-party service outages, API changes, permission denials, or data quality issues outside Service Provider control.

## 11. Compliance

Each party will comply with laws applicable to its performance under this Agreement.

Service Provider will not provide legal, financial, investment, employment, or tax advice as part of the Services.

## 12. Warranties

Service Provider warrants that the Services will be performed in a professional and workmanlike manner.

Except as expressly stated, the Services and Deliverables are provided without additional warranties, including implied warranties of merchantability, fitness for a particular purpose, and non-infringement.

## 13. Indemnification

Service Provider will defend Customer against third-party claims alleging that a Deliverable, as provided by Service Provider and used as authorized, infringes a United States intellectual property right.

Customer will defend Service Provider against third-party claims arising from Customer Data, Customer systems, or Customer's use of Deliverables in violation of this Agreement.

## 14. Limitation of Liability

Neither party will be liable for indirect, incidental, special, consequential, exemplary, or punitive damages.

Each party's aggregate liability under this Agreement is capped at the fees paid or payable in the twelve months before the claim.

The liability cap does not apply to payment obligations, confidentiality breaches, data misuse, indemnification obligations, or willful misconduct.

## 15. Audit and Records

Service Provider will keep accurate records of Services performed, milestone status, and approved expenses.

Upon reasonable notice, Customer may review records necessary to verify invoices and compliance with agreed approval boundaries.

## 16. Notices

Notices must be in writing and delivered by personal delivery, recognized overnight courier, or email with confirmation of receipt.

Notices to Customer will be sent to legal@atlasharbor.example. Notices to Service Provider will be sent to legal@northstarforge.example.

## 17. Assignment

Neither party may assign this Agreement without the other party's prior written consent, except to an affiliate or in connection with a merger, reorganization, or sale of substantially all assets.

## 18. Governing Law

This Agreement is governed by the laws of the State of New York, without regard to conflicts of law rules.

The parties consent to exclusive jurisdiction and venue in the state and federal courts located in New York County, New York.

## 19. Order of Precedence

If there is a conflict, the main body of this Agreement controls over Schedule 1, and a later signed amendment controls over both.

## 20. Entire Agreement

This Agreement, including Schedule 1, is the entire agreement between the parties regarding the Services and supersedes prior discussions and proposals.

Any amendment must be in writing and signed by both parties.

## Schedule 1 - Description of Services

| Workstream | Deliverable |
| --- | --- |
| Discovery | Project plan, access checklist, delivery calendar |
| Connectors | Gmail, Google Calendar, Notion, and Slack setup guides and implementation |
| Workflows | Inbox triage, meeting preparation, and contract follow-up workflows |
| Enablement | Admin training, acceptance report, and 30-day support |

## Schedule 2 - Milestones

| Milestone | Fee | Acceptance Evidence |
| --- | --- | --- |
| Kickoff | USD 12,500 | Project plan approved |
| Connector build | USD 27,500 | Test connectors configured |
| Workflow launch | USD 35,000 | Acceptance checklist completed |
| Enablement | USD 20,000 | Training delivered |

## Signatures

Atlas Harbor Analytics, Inc.

By: ______________________________

Name: ____________________________

Title: ___________________________

Date: ____________________________

Northstar Forge Labs Ltd.

By: ______________________________

Name: ____________________________

Title: ___________________________

Date: ____________________________
`;

async function mockCompletedOnboarding(page: Page): Promise<void> {
  await mockTauri(page, { settings: SETTINGS, token: 'mock-token-abc' });
}

test.describe('service agreement generation from uploaded PDF template', () => {
  test('uploads a services-agreement PDF and exports a clause-preserving generated agreement as multi-page PDF', async ({
    page
  }) => {
    await mockCompletedOnboarding(page);
    await mockGateway(page, {
      threads: [],
      mockedReply: GENERATED_AGREEMENT
    });
    await mockGatewaySurfaces(page);

    let postedBody: Record<string, unknown> | null = null;
    await page.route(/\/api\/webchat\/v2\/threads\/([^/]+)\/messages$/, async (route) => {
      postedBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fallback();
    });

    await page.goto('/chat');
    await expect(page.getByTestId('reborn-chat-panel')).toBeVisible({ timeout: 10_000 });

    const chooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Attach files' }).click();
    const chooser = await chooserPromise;
    await chooser.setFiles(
      HAS_REAL_SOURCE_PDF
        ? SOURCE_PDF
        : {
            name: 'detailed-services-agreement-template.pdf',
            mimeType: 'application/pdf',
            buffer: DUMMY_TEMPLATE_PDF
          }
    );

    const composer = page.getByPlaceholder('Message IronClaw…');
    const prompt =
      'Using the attached services agreement PDF as the template, generate a new services agreement for Atlas Harbor Analytics, Inc. and Northstar Forge Labs Ltd. Fees are USD 95,000 over four milestones, term is 12 months, governing law is New York, and no external send or filing is approved.';
    await composer.fill(prompt);
    const send = page.getByRole('button', { name: /^Send( message)?$/ });
    await expect(send).toBeEnabled({ timeout: 5000 });
    await send.click();

    await expect(page.getByText('Atlas Harbor Analytics, Inc.').first()).toBeVisible({
      timeout: 5000
    });
    await expect(page.getByText('Northstar Forge Labs Ltd.').first()).toBeVisible();
    await expect
      .poll(() => postedBody)
      .toMatchObject({
        content: prompt,
        attachments: [expect.objectContaining({ mime_type: 'application/pdf' })]
      });
    expect(JSON.stringify(postedBody)).not.toContain('Work item:');
    await expect(
      page.getByText('Provider will not train models on Customer Data.').first()
    ).toBeVisible();
    await expect(page.getByText('Limitation of Liability').first()).toBeVisible();
    await expect(page.getByText('Governing Law').first()).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export Assistant response as PDF' }).last().click()
    ]);

    expect(download.suggestedFilename()).toBe('assistant-response.pdf');
    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
    const pdfBytes = await readFile(downloadPath!);
    const pdf = pdfBytes.toString('latin1');
    const pageCount = pdf.match(/\/Type \/Page\b/g)?.length ?? 0;
    expect(pageCount).toBeGreaterThanOrEqual(2);
    expect(pdf).toContain('(SERVICES AGREEMENT) Tj');
    expect(pdf).toMatch(/\(\d+\. CUSTOMER DATA AND SECURITY\) Tj/u);
    expect(pdf).toContain('(Provider will not train models on Customer Data.) Tj');
    expect(pdf).toMatch(/\(\d+\. LIMITATION OF LIABILITY\) Tj/u);
    expect(pdf).toMatch(/\(\d+\. GOVERNING LAW\) Tj/u);
    if (EXPORT_OUT) {
      await mkdir(dirname(EXPORT_OUT), { recursive: true });
      await download.saveAs(EXPORT_OUT);
    }
  });
});
