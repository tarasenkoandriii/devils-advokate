import { Dictionary } from '../dictionary';

export const en: Dictionary = {
  meta: {
    title: "Devil's Advocate — Prepare for the conversation that gets you the outcome you need",
    description:
      'An AI-powered space to prepare for a difficult conversation, practice it, have it, and learn from how it actually went — not another pros-and-cons calculator.',
  },
  hero: {
    headline: "It's not about weighing pros and cons. It's about preparing to say them out loud.",
    subheadline:
      "Asking for a raise, negotiating a divorce settlement, closing a difficult deal — Devil's Advocate helps you prepare, rehearse, and walk into the conversation ready.",
    cta: 'Open in Telegram',
  },
  courtroomCallouts: [
    {
      icon: 'shield-check',
      title: 'Your personal AI assistant in court',
      description:
        'Analyzes speech in real time, finds contradictions and suggests how to get to the truth.',
      side: 'left',
    },
    {
      icon: 'case-dossier',
      title: 'Case Dossier',
      description: 'Timeline of events, documents, transcripts, exhibits, statements, notes.',
      side: 'left',
    },
    {
      icon: 'context',
      title: 'Understands context',
      description: 'Knows your case, strategy and previous hearings.',
      side: 'left',
    },
    {
      icon: 'waveform-alert',
      title: 'Lying or evading?',
      description: 'Detects probable lies and evasions based on prior statements and documents.',
      side: 'right',
    },
    {
      icon: 'scales',
      title: 'Arguments & law',
      description: 'Relevant laws, precedents and strong arguments at your fingertips.',
      side: 'right',
    },
    {
      icon: 'lock',
      title: 'Privacy first',
      description: 'All recordings are stored locally. You control your data.',
      side: 'right',
    },
  ],
  phoneMockup: {
    brand: "Devil's Advocate",
    liveStatus: 'LIVE',
    mode: 'MODE: COURT HEARING',
    speaker: 'Witness: Anna Petrova',
    alertTitle: 'HIGH LIKELIHOOD OF INACCURACY',
    alertDetail: 'Contradiction with prior statements and documents',
    riskLow: 'Low risk',
    riskHigh: 'High risk',
    whyFlaggedTitle: "Why it's flagged",
    whyFlaggedReasons: [
      'Earlier statement contradicts current testimony',
      'Contradiction with Exhibit 12',
      'Inconsistent answer to direct question',
    ],
    whatToAskTitle: 'What to ask next',
    suggestedQuestions: [
      'Can you clarify when exactly this happened?',
      'Who else was present at that time?',
      'Why did you state a different date before?',
    ],
    strategicSuggestionTitle: 'Strategic suggestion',
    strategicSuggestionText: 'Impeach with the prior statement from 12.03.2024.',
    navNotes: 'Notes',
    navDocuments: 'Documents',
    navTimeline: 'Timeline',
    navAnalysis: 'Analysis',
    navMore: 'More',
  },
  bottomFeatures: [
    {
      title: 'Real-time speech analysis',
      description: 'Intonation, pauses, uncertainty, emotional markers.',
    },
    {
      title: 'Contradiction detection',
      description: 'Compares with case file, documents and prior statements.',
    },
    {
      title: 'Tips & questions',
      description: 'Ready-made questions and strategies for the current situation.',
    },
    {
      title: 'On-hand documents',
      description: 'Quick access to files and evidence.',
    },
    {
      title: 'History & analytics',
      description: 'Hearing review and progress tracking by case.',
    },
    {
      title: 'Full control',
      description: 'Local storage, no leaks, your rules.',
    },
  ],
  technology: {
    eyebrow: 'Technology',
    title: 'Not fragmented. Not forgotten.',
    subtitle:
      "Your calendar, notes, files, emails, AI chats and recordings — pulled into one place, with real context, not just stored side by side.",
    groups: [
      {
        title: 'Not fragmented. Not forgotten.',
        items: [
          { icon: 'calendar', text: 'Calendar', description: 'Events; Appointments; Reminders' },
          { icon: 'chatgpt', text: 'ChatGPT', description: 'Chats; AI answers; Prompts' },
          { icon: 'voice_recorder', text: 'Voice recorder', description: 'Recordings; Interviews; Ideas' },
          { icon: 'notes', text: 'Notes', description: 'Notes; Drafts; Checklists' },
          { icon: 'files', text: 'Files', description: 'Documents; PDFs; Attachments' },
          { icon: 'email', text: 'Email', description: 'Messages; Threads; Attachments' },
        ],
      },
      {
        title: 'All in one place. Always with context.',
        items: [
          {
            icon: 'alert',
            text: 'Risk alert',
            description: 'Potential contradiction or risk detected in the live conversation.',
          },
          {
            icon: 'lightbulb',
            text: 'Suggestion',
            description: 'Contextual guidance generated in real time.',
          },
          {
            icon: 'shield',
            text: 'Protected insight',
            description: 'A protected, context-aware insight linked to the conversation.',
          },
          {
            icon: 'target',
            text: 'Strategic signal',
            description: 'A signal that helps focus the next move.',
          },
          {
            icon: 'document',
            text: 'Case record',
            description: 'Relevant case information kept together with the conversation context.',
          },
        ],
      },
      {
        title: 'Structured knowledge. Always at hand.',
        items: [
          {
            icon: 'person',
            text: 'Person profile',
            description: 'Key information, relationships, roles, and preferences.',
            tag: 'Personal record',
          },
          {
            icon: 'document',
            text: 'Public fact',
            description: 'Verified information from reliable sources.',
            tag: 'Public source',
          },
          {
            icon: 'brain',
            text: 'AI guess (not a fact)',
            description: 'AI-generated insights, clearly separated.',
            tag: 'AI guess',
          },
          {
            icon: 'chat',
            text: 'Conversation thread',
            description: 'Discussion history with full context.',
            tag: 'Communication',
          },
          {
            icon: 'calendar',
            text: 'Event & timeline',
            description: 'Important dates, activities, and milestones.',
            tag: 'Event',
          },
          {
            icon: 'shield',
            text: 'Source & confidence',
            description: 'Every item tagged with source and confidence.',
            tag: 'Verified',
          },
        ],
      },
      {
        title: 'Privacy & Security',
        items: [
          { icon: 'wifi', text: 'Works offline', description: 'Your data stays with you' },
          { icon: 'lock', text: 'Strong encryption', description: 'Industry-standard protection' },
          { icon: 'servers', text: 'Local storage', description: 'No data in the cloud' },
          { icon: 'people', text: 'No tracking', description: 'No analytics, no profiling' },
          {
            icon: 'integrations',
            text: 'Third-party free',
            description: 'No hidden sharing or selling',
          },
          { icon: 'rocket', text: 'Always improving', description: 'Privacy-first by design' },
        ],
      },
    ],
  },
  technologyPhone: {
    liveLabel: 'LIVE',
    currentAgendaLabel: 'Current agenda',
  },
  privacyPolicy: {
    eyebrow: 'Privacy & Security',
    title: 'Built to protect, end to end',
    subtitle:
      'From the moment a conversation is captured to the moment you decide to delete it — every step is designed around your control, not ours.',
    groups: [
      {
        title: 'Privacy Principles',
        items: [
          { id: 'workflow_prepare', text: 'Privacy First', description: 'Privacy comes before everything else.' },
          {
            id: 'workflow_live',
            text: 'Secure by Default',
            description: 'Protection is built in from the start, not added later.',
          },
          {
            id: 'workflow_guidance',
            text: 'You Own Your Data',
            description: 'Your information stays yours, always.',
          },
          {
            id: 'workflow_capture',
            text: 'Full Control at All Times',
            description: 'Decide what stays, what goes, and who sees it.',
          },
          {
            id: 'workflow_review',
            text: 'Responsible by Nature',
            description: 'Built with care for the people who trust us.',
          },
          {
            id: 'workflow_privacy',
            text: 'Privacy by Default',
            description: 'Privacy and protection are built into the workflow.',
          },
        ],
      },
      {
        title: 'Voice Processing Pipeline',
        items: [
          { id: 'pipeline_capture', text: 'Capture Audio', description: 'Capture the conversation signal.' },
          {
            id: 'pipeline_noise',
            text: 'Noise Suppression',
            description: 'Reduce background noise and isolate speech.',
          },
          { id: 'pipeline_transcribe', text: 'Speech Recognition', description: 'Convert speech into text.' },
          {
            id: 'pipeline_understand',
            text: 'Understand & Analyze',
            description: 'Interpret context, meaning, and signals.',
          },
          {
            id: 'pipeline_generate',
            text: 'Generate Guidance',
            description: 'Generate contextual suggestions.',
          },
          {
            id: 'pipeline_deliver',
            text: 'Deliver Guidance',
            description: 'Deliver the suggestion to the user.',
          },
        ],
      },
      {
        title: 'Privacy Protection Network',
        items: [
          {
            id: 'central_home',
            text: 'Protected Environment',
            description: 'Protected environment for private work.',
          },
          {
            id: 'central_settings',
            text: 'Security Controls',
            description: 'Configure and manage protection controls.',
          },
          {
            id: 'central_lock',
            text: 'Access Protection',
            description: 'Protect access to sensitive information.',
          },
          {
            id: 'central_user',
            text: 'User Control',
            description: 'Keep control of who can access information.',
          },
          {
            id: 'central_shield',
            text: 'Data Protection',
            description: 'Protect information throughout its lifecycle.',
          },
          {
            id: 'central_delete',
            text: 'Secure Deletion',
            description: 'Remove protected information when it is no longer needed.',
          },
          {
            id: 'central_verified_doc',
            text: 'Verified Records',
            description: 'Keep records with a clear verification status.',
          },
          {
            id: 'central_cloud_block',
            text: 'Cloud Protection',
            description: 'Prevent unauthorized cloud exposure.',
          },
        ],
      },
      {
        title: 'Supported Attachments',
        items: [
          { id: 'attachment_documents', text: 'Documents', description: 'PDF, DOCX, TXT' },
          { id: 'attachment_tables', text: 'Tables & Reports', description: 'XLSX, CSV' },
          { id: 'attachment_images', text: 'Images & Scans', description: 'JPG, PNG' },
          {
            id: 'attachment_audio_video',
            text: 'Audio & Video',
            description: 'MP3, M4A, WAV, MP4, MOV',
          },
          { id: 'attachment_links', text: 'Links & Articles', description: 'Web pages, research' },
        ],
      },
      {
        title: 'Data Processing',
        items: [
          {
            id: 'processing_extract',
            text: 'Extract Text & Data',
            description: 'Extract usable text and structured data from inputs.',
          },
          {
            id: 'processing_index',
            text: 'Index & Understand Meaning',
            description: 'Index content and understand its meaning.',
          },
          {
            id: 'processing_link',
            text: 'Connect to Conversation Topic',
            description: 'Connect extracted information to the current conversation topic.',
          },
          {
            id: 'processing_use',
            text: 'Use in Guidance & Review',
            description: 'Use relevant information in suggestions and post-conversation review.',
          },
        ],
      },
      {
        title: 'Sources & Reliability',
        items: [
          {
            id: 'source_public',
            text: 'Public Source',
            description: 'Information from publicly available sources.',
          },
          {
            id: 'source_private',
            text: 'Private',
            description: 'Information from a private user-provided record.',
          },
          {
            id: 'source_ai',
            text: 'AI Insight',
            description: 'AI-generated interpretation or analysis.',
          },
          {
            id: 'source_assumption',
            text: 'Assumption',
            description: 'Information identified as a user-provided assumption.',
          },
        ],
      },
      {
        title: 'Security & Platform Controls',
        items: [
          {
            id: 'control_offline',
            text: 'Works Offline',
            description: 'Core processing can run locally on the device.',
          },
          {
            id: 'control_encryption',
            text: 'End-to-End Encryption',
            description: 'Encrypted protection for audio, text, and attachments.',
          },
          {
            id: 'control_storage',
            text: 'Storage Choice',
            description: 'Choose local or cloud storage under your control.',
          },
          {
            id: 'control_share',
            text: 'Safe Share',
            description: 'Share only what you choose, with the people you choose.',
          },
          {
            id: 'control_integrations',
            text: 'Integrations',
            description: 'Connect calendars, notes, CRM, and messaging tools.',
          },
          {
            id: 'control_growth',
            text: 'Calibration & Growth',
            description: 'Improve the model through conversation review and calibration.',
          },
        ],
      },
    ],
  },
  cycle: {
    eyebrow: 'How it works',
    title: 'One cycle, every conversation that matters',
    steps: [
      {
        title: 'Prepare',
        description: 'Your goal, your strongest arguments, and the weak spots in your own position.',
      },
      {
        title: 'Practice',
        description: 'Spar with an AI counterpart before the real conversation happens.',
      },
      {
        title: 'Talk',
        description: 'Have the conversation, with a recording that stays yours.',
      },
      {
        title: 'Review',
        description: "See what worked and what didn't, while it's still fresh.",
      },
      {
        title: 'Learn',
        description: 'Calibrate against real outcomes over time, not just this one talk.',
      },
    ],
    overlay: {
      stages: [
        { label: 'PREPARE', description: 'Set the goal and key questions.' },
        { label: 'TALK', description: 'Listen, speak, and capture the exchange.' },
        { label: 'CLARIFY', description: 'Surface context, questions, and signals.' },
        { label: 'ANALYZE', description: 'Check evidence, patterns, and risks.' },
        { label: 'LEARN & ACT', description: 'Turn insights into next steps.' },
      ],
      center: 'LISTEN • UNDERSTAND • ADVISE',
      pipeline: [
        'CAPTURE AUDIO',
        'NOISE REDUCTION',
        'SPEECH RECOGNITION',
        'UNDERSTAND & ANALYZE',
        'GENERATE SUGGESTION',
        'DELIVER SUGGESTION',
      ],
    },
  },
  differentiation: {
    title: 'Not another pros-and-cons calculator',
    themLabel: 'Calculators',
    themText: 'A one-time list of pluses and minuses for a single decision.',
    usLabel: "Devil's Advocate",
    usText:
      'Preparation for a specific conversation with a specific person — and a memory of that relationship that carries forward.',
  },
  privacy: {
    title: 'Privacy is not a footnote here',
    intro:
      "This is the part most tools treat as legal boilerplate. We treat it as the reason people trust us with conversations they can't afford to get wrong.",
    points: [
      {
        title: 'Raw recordings never touch our servers',
        description: 'They stay on your device. Always.',
      },
      {
        title: 'Safe Share shows you the preview first',
        description: 'See exactly what the recipient will see, before anything is sent.',
      },
      {
        title: 'Export or delete your data in one click',
        description: "Nothing you can't see, control, or remove yourself.",
      },
    ],
    policyLink: 'Read the full Privacy Policy',
  },
  features: {
    title: 'Three things worth knowing before you open the app',
    items: [
      {
        title: "Devil's Advocate / Steelman",
        description:
          "Train from both sides before the real thing: attack your own position, then build the strongest possible version of the other side's.",
      },
      {
        title: 'Conversation Card',
        description:
          'One cheat sheet: your goal, your arguments, what not to bring up, how to open and how to close.',
      },
      {
        title: 'Decision calibration',
        description:
          'Over time, see exactly where your own predictions tend to go wrong — and get better at trusting yourself.',
      },
    ],
  },
  howItWorks: {
    title: 'Lives inside Telegram',
    description:
      "Devil's Advocate is a Telegram Mini App — no separate download, no new account. Open Telegram, open the app, start preparing.",
  },
  faq: {
    title: 'Before you ask',
    items: [
      {
        q: 'Who can see my conversations?',
        a: 'Only you. Raw recordings stay on your device — see the Privacy section above for the specifics.',
      },
      {
        q: 'Is it legal to record a conversation?',
        a: "It depends on where you are and who you're talking to — recording laws vary by jurisdiction and by whether the other person consents. We're not able to give legal advice here; check our Terms of Service and your local law before recording anyone.",
      },
      {
        q: 'Do I have to pay?',
        a: "You can start for free. If that changes for specific features, we'll say so clearly before you're ever asked to pay.",
      },
      {
        q: 'What platforms does it work on?',
        a: 'Anywhere Telegram runs — phone, tablet, or desktop. No separate app to install.',
      },
    ],
  },
  finalCta: {
    title: 'Your next hard conversation is coming either way',
    subtitle: 'You might as well walk in prepared.',
    cta: 'Open in Telegram',
  },
  footer: {
    tagline: 'Preparation for the conversations that actually matter.',
    privacyPolicy: 'Privacy Policy',
    termsOfService: 'Terms of Service',
    contact: 'Contact',
    antiSurveillanceNote:
      "Devil's Advocate is built to help you prepare for your own conversations — not to monitor anyone else's.",
  },
};
