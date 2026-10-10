# HOW ARE YOU FEELING?
### Doctors miss many of the side effects patients actually feel between visits. Build the check-in agent that asks, listens, and gets the right information to the research team.

---

## 1. The problem, in one breath

Between trial visits, patients experience symptoms and start or stop other medications. Some of these are **adverse events (AEs)** the trial must record. Others are dangerous. Today, much of this surfaces only at the next visit, from memory. NCI notes that the standard approach, where investigators report symptoms, **underdetects symptomatic AEs**, which is why it created **PRO-CTCAE**, a library of patient-reported questions. Of 790 AE terms, 78 can be meaningfully self-reported ([NCI PRO-CTCAE](https://healthcaredelivery.cancer.gov/pro-ctcae/testing.html); [JNCI 2014](https://pubmed.ncbi.nlm.nih.gov/25265940/)).

On the chart side, Mass General Brigham deployed an **irAE-Agent** that detects immune-related adverse events in clinical notes, and published a field guide on deploying such agents ([arXiv](https://arxiv.org/pdf/2509.26153)).

## 2. Your mission

**Build an AE and concomitant-medication capture agent that runs structured symptom check-ins (by voice or text) between visits, scans new chart notes for possible AEs and medication changes, and delivers a reviewed, structured summary to the research team.**

- **Input:** Check-in responses (voice or text), new EHR notes and medication lists, and the study's AE reporting rules.
- **Output:** Structured symptom reports, possible-AE flags with evidence, medication-change lists, urgent escalations, and draft entries for the coordinator to confirm.
- **User:** A research nurse or coordinator, with the investigator reviewing.

## 3. Clinical trials in 90 seconds

- **Site agents** work for the hospital or clinic's research team, not the drug company. They run inside the hospital's own systems, especially its **electronic health record (EHR)**, and often reuse agents the hospital already runs for everyday care (the "hospital twin").
- An AE is any health problem during a trial, whether or not the drug caused it. **Serious** AEs have strict reporting clocks.
- **Con-meds** (other medications) must be recorded because they can interact or confound.
- PRO-CTCAE asks about frequency, severity, and interference over "the past 7 days".

## 4. Words you'll need

| Term | Meaning |
|---|---|
| AE / SAE | Adverse event / serious adverse event |
| Con-med | Concomitant medication |
| PRO-CTCAE | NCI's patient-reported symptom question library |
| CTCAE grade | Severity grade (1 mild to 5 death) |
| Symptom check-in | Scheduled patient-reported symptom survey |
| Attribution | Investigator's judgment of whether the drug caused it |

## 5. How it's done today

**Who:** Research nurses, coordinators, and investigators, with the sponsor's safety team downstream.

**Steps:** Ask patients at visits, read charts for new problems, and enter AEs and con-meds into the EDC by hand.

**Example tools:**

| Job | Examples | Notes |
|---|---|---|
| Voice agent frameworks (open source) | [Pipecat (open-source voice agents)](https://github.com/pipecat-ai/pipecat), LiveKit Agents | Speech in, reasoning and tool calls, speech out |
| Telephony | Twilio Voice and similar programmable phone APIs | Use trial accounts and your own phones only |
| Chart-review agents | Academic agents such as MGB's irAE-Agent ([A field guide to deploying AI agents in clinical practice: the irAE-Agent (arXiv)](https://arxiv.org/pdf/2509.26153)) | Hospital twin: quality and safety reporting review |
| Patient-reported outcome tools | ePRO vendors; PRO-CTCAE electronic systems | Structured symptom capture |

**Where it breaks:** Symptoms are forgotten by the next visit. Notes mention problems that never reach the EDC. Medication changes go unrecorded. Urgent symptoms reported casually aren't escalated.

## 6. Data you can get (all free)

| Source | What's in it | How to use it |
|---|---|---|
| [NCI PRO-CTCAE: development and item library](https://healthcaredelivery.cancer.gov/pro-ctcae/testing.html) | The validated patient-reported symptom items and how they were tested | Your check-in question set |
| [NCI CTCAE files](https://evs.nci.nih.gov/ftp1/CTCAE/) | Severity grading | Grade captured symptoms |
| [CDISC SDTM/ADaM pilot project](https://github.com/cdisc-org/sdtm-adam-pilot-project) | AE and con-med data structures | Your output format |
| [A field guide to deploying AI agents in clinical practice: the irAE-Agent (arXiv)](https://arxiv.org/pdf/2509.26153) | Real deployment lessons for a clinical AE agent | Design and governance ideas |
| [Synthea](https://github.com/synthetichealth/synthea) | Synthetic notes and medication lists | Chart-scan input |

## 7. Data you'll have to fake (and how)

- **Personas:** patients reporting mild nausea, a rash, worsening shortness of breath (urgent), a new antibiotic from urgent care, confusion about whether a symptom "counts", or a caregiver answering.
- **Notes:** synthetic clinic notes mentioning AEs indirectly ("pt reports 3 days of diarrhea, started loperamide").
- **Answer key:** expected AEs, grades, con-meds, and escalations.

## 8. Build it: Good / Better / Best

**GOOD: "Check-In Agent."** A voice or text check-in using a small PRO-CTCAE-style item set that captures structured answers, assigns a provisional grade, and escalates urgent responses. *Demo-able by hour 8.*

**BETTER: "Check-In + Chart Scan."** Everything in Good, plus scanning new synthetic notes and medication lists for possible AEs and con-med changes, merging them with check-in data, and showing evidence for each flag. Report precision and recall against your answer key.

**BEST: "AE Capture Desk."** Everything in Better, plus draft EDC AE and con-med entries for coordinator confirmation, de-duplication across sources, a serious-AE clock that starts when the site becomes aware, multilingual voice, and an investigator review screen for attribution.

## 9. How you'll be judged

| Criterion | What judges look for |
|---|---|
| **Solves the problem** | Would more real side effects be captured accurately and sooner, with no urgent one missed? |
| **It works** | End-to-end demo. Runs from a clean clone, following the README. |
| **Smart use of data** | Real public data where it exists. Simulated data that is believable and documented. |
| **Explains itself** | Every output shows its evidence and reasoning |
| **Craft and demo** | Clean code, a clear story, and a good UI for the time available |

## 10. Rules of the road

Use public or synthetic data only, and cite every source. Vendor names are examples, not endorsements. The investigator decides seriousness and attribution. Voice agents must say they are automated at the start of every call, offer a human at any point, never give medical advice, send emergencies to 911 immediately, and call only people who consented (in the U.S., the FCC treats AI voices as "artificial" under the TCPA). In your demo, call only teammates' phones.

---

## 11. Links

**Start here**
- [NIH: Clinical Research Trials and You](https://www.nih.gov/health-information/nih-clinical-research-trials-you)
- [NIAMS: What is a clinical trial?](https://niams.nih.gov/labs/clinical-trials/what-is-clinical-trial)

**The problem**
- [NCI PRO-CTCAE: development and item library](https://healthcaredelivery.cancer.gov/pro-ctcae/testing.html)
- [PRO-CTCAE development (JNCI 2014)](https://pubmed.ncbi.nlm.nih.gov/25265940/)
- [A field guide to deploying AI agents in clinical practice: the irAE-Agent (arXiv)](https://arxiv.org/pdf/2509.26153)

**Voice building blocks**
- [Pipecat (open-source voice agents)](https://github.com/pipecat-ai/pipecat)
- [LiveKit Agents overview](https://livekit.com/blog/best-open-source-voice-and-video-ai-agent-frameworks)
- [FCC: AI voices are "artificial" under the TCPA (Cooley summary)](https://cooley.com/news/insight/2024/2024-02-15-fcc-ai-generated-robocalls-illegal-under-the-tcpa)

**Data**
- [NCI CTCAE files](https://evs.nci.nih.gov/ftp1/CTCAE/)
- [CDISC SDTM/ADaM pilot project](https://github.com/cdisc-org/sdtm-adam-pilot-project)
- [Synthea](https://github.com/synthetichealth/synthea)

**EHR sandboxes and standards**
- [SMART Health IT sandbox](https://launch.smarthealthit.org)
- [HAPI FHIR test server](https://hapi.fhir.org/)
- [Epic FHIR developer docs and sandbox](https://fhir.epic.com)
- [HL7 FHIR R4](https://hl7.org/fhir/R4/)

---
<sub>sage_ae_&_con-med_capture_(data_agents)</sub>
