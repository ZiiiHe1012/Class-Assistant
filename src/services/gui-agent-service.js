import crypto from 'crypto';

const QUESTION_CATEGORY_IDS = new Set([2, 3, 4]);
const MAX_AGENT_STEPS = 12;

class GuiAgentActionParseError extends Error {
  constructor(message, debugResponse = '') {
    super(message);
    this.name = 'GuiAgentActionParseError';
    this.debugResponse = debugResponse;
  }
}

function asString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function stringifyList(value) {
  return asArray(value).map((item) => asString(item)).filter(Boolean).join(', ');
}

function answerTypeForCategory(categoryId) {
  const id = Number(categoryId);
  if (id === 2) return 'choice';
  if (id === 3) return 'fill';
  if (id === 4) return 'subjective';
  return '';
}

function fallbackAnswers(capture) {
  const p = capture?.payload || {};
  const type = answerTypeForCategory(capture?.categoryId);

  if (type === 'choice') {
    const explicit = asArray(p.answers).map((item) => asString(item)).filter(Boolean);
    if (explicit.length) return explicit;
    return asArray(p.options)
      .filter((option) => option?.isAnswer)
      .map((option) => asString(option.key) || asString(option.text))
      .filter(Boolean);
  }

  if (type === 'fill') {
    return asArray(p.blanks).map((blank) => asString(blank?.answer)).filter(Boolean);
  }

  if (type === 'subjective') {
    return [asString(p.sampleAnswer) || asString(p.explanation)].filter(Boolean);
  }

  return [];
}

function renderTemplate(template, capture) {
  const p = capture?.payload || {};
  const blankAnswers = asArray(p.blanks)
    .map((blank) => `${blank.index || ''}:${asString(blank.answer)}`)
    .filter((item) => item !== ':')
    .join(', ');

  const map = {
    categoryName: capture?.categoryName || '',
    questionStem: p.questionStem || '',
    answers: stringifyList(p.answers || []),
    blankAnswers,
    sampleAnswer: p.sampleAnswer || '',
    explanation: p.explanation || capture?.renderedMarkdown || '',
    knowledgePoints: stringifyList(p.knowledgePoints || []),
    ocrText: capture?.ocrText || '',
    renderedMarkdown: capture?.renderedMarkdown || '',
    title: capture?.title || '',
    reason: capture?.reason || '',
    answerType: answerTypeForCategory(capture?.categoryId),
    fallbackAnswers: stringifyList(fallbackAnswers(capture))
  };

  return String(template || '').replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key) => map[key] ?? '');
}

function extractJson(text) {
  const raw = asString(text);
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;

  try {
    return JSON.parse(candidate.slice(start, end + 1).replace(/,\s*([}\]])/g, '$1'));
  } catch {
    return null;
  }
}

function formatDebugResponse({ rawResponse, responseText, recentActions, step, note }) {
  return [
    note || 'GUI agent response debug',
    '',
    `Step: ${step || ''}`,
    '',
    'Recent action signatures:',
    JSON.stringify(asArray(recentActions).slice(-5), null, 2),
    '',
    'Parsed model content:',
    asString(rawResponse) || '(empty)',
    '',
    'Raw HTTP response preview:',
    String(responseText || '').slice(0, 1200) || '(empty)'
  ].join('\n');
}

function collectChatContent(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  return choices.map((choice) => {
    const delta = choice?.delta?.content;
    const message = choice?.message?.content;
    if (typeof delta === 'string') return delta;
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) {
      return message.map((item) => asString(item?.text || item?.content)).filter(Boolean).join('');
    }
    return '';
  }).filter(Boolean).join('');
}

function parseModelResponseText(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';

  if (raw.startsWith('data:')) {
    const parts = [];
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        parts.push(collectChatContent(JSON.parse(data)));
      } catch {
        // Ignore malformed SSE bookkeeping lines and keep parsing useful chunks.
      }
    }
    return parts.filter(Boolean).join('');
  }

  const parsed = JSON.parse(raw);
  const content = collectChatContent(parsed);
  if (content) return content;
  if (parsed && typeof parsed === 'object' && (parsed.action || parsed.done)) return raw;
  return '';
}

function normalizeAction(value) {
  const action = value && typeof value === 'object' ? value : {};
  const target = action.target && typeof action.target === 'object' ? action.target : {};
  return {
    action: asString(action.action) || (action.done ? 'finish' : ''),
    target: {
      id: asString(target.id),
      selector: asString(target.selector),
      text: asString(target.text),
      x: Number.isFinite(Number(target.x)) ? Number(target.x) : null,
      y: Number.isFinite(Number(target.y)) ? Number(target.y) : null
    },
    value: asString(action.value),
    done: Boolean(action.done),
    reason: asString(action.reason || action.thought || action.note)
  };
}

function hasTarget(target) {
  return Boolean(
    target?.id ||
    target?.selector ||
    target?.text ||
    (Number.isFinite(target?.x) && Number.isFinite(target?.y))
  );
}

function validateAction(action) {
  if (!action || typeof action !== 'object') return 'GUI action is empty';
  if (action.done || action.action === 'finish') return '';
  if (action.action === 'wait') return '';
  if (action.action === 'click') {
    return hasTarget(action.target) ? '' : 'click action requires target.id, target.text, target.selector, or target.x/y';
  }
  if (action.action === 'type') {
    if (!hasTarget(action.target)) return 'type action requires target.id, target.text, target.selector, or target.x/y';
    if (!action.value) return 'type action requires value';
    return '';
  }
  return `Unsupported GUI action: ${action.action || '(empty)'}`;
}

function typeCoordinateWarning(action, observation) {
  const target = action?.target || {};
  const usesCoordinatesOnly = action?.action === 'type' &&
    !target.id &&
    !target.selector &&
    !target.text &&
    Number.isFinite(target.x) &&
    Number.isFinite(target.y);

  if (!usesCoordinatesOnly || !hasEditableElement(observation)) return '';
  return 'Warning: editable:true elements are visible; prefer target.id for type instead of x/y coordinates.';
}

function actionSignature(action) {
  if (!action || typeof action !== 'object') return 'empty';
  if (action.done || action.action === 'finish') return 'finish';

  const target = action.target || {};
  let targetKey = '';
  if (target.id) targetKey = `id=${target.id}`;
  else if (target.selector) targetKey = `selector=${target.selector}`;
  else if (target.text) targetKey = `text=${target.text}`;
  else if (Number.isFinite(target.x) && Number.isFinite(target.y)) targetKey = `x=${Math.round(target.x)}:y=${Math.round(target.y)}`;
  else targetKey = 'target=none';

  const valueKey = action.action === 'type' ? `:value=${asString(action.value).slice(0, 40)}` : '';
  return `${action.action || 'unknown'}:${targetKey}${valueKey}`;
}

function isRepeatedNoProgressAction(session, action) {
  const signature = actionSignature(action);
  const recent = asArray(session.actionSignatures).slice(-2);
  const lastResult = asArray(session.history).slice().reverse().find((item) => item.role === 'act_result')?.result || {};
  const noProgress = lastResult.changed === false || lastResult.after?.changed === false;
  return action.action === 'click' && noProgress && recent.length === 2 && recent.every((item) => item === signature);
}

function matchesSubmitLikeText(value) {
  return /\u63d0\u4ea4|\u786e\u5b9a|\u5b8c\u6210|\u4ea4\u5377|submit|confirm|finish/i.test(asString(value));
}

function isSubmitLikeAction(action) {
  if (!action || action.action !== 'click') return false;
  const target = action.target || {};
  return matchesSubmitLikeText([
    target.id,
    target.selector,
    target.text,
    action.reason
  ].filter(Boolean).join(' '));
}

function isSubmitLikeResult(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.submitted === true) return true;
  if (result.action !== 'click') return false;
  return matchesSubmitLikeText([
    result.targetText,
    result.targetId,
    result.targetTag
  ].filter(Boolean).join(' '));
}

function lastModelAction(session) {
  return asArray(session?.history).slice().reverse().find((item) => item.role === 'model')?.action || null;
}

function hasSubmittedObservationSignal(observation) {
  const text = `${observation?.pageText || ''} ${asArray(observation?.elements).map((el) => `${el.text || ''} ${el.value || ''}`).join(' ')}`;
  return /\u63d0\u4ea4\u6210\u529f|\u5df2\u63d0\u4ea4|\u4f5c\u7b54\u5b8c\u6210|\u5b8c\u6210\u63d0\u4ea4|submitted successfully|answer submitted|\bsubmitted\b/i.test(text);
}

function shouldAutoFinishAfterObservation(session, observation) {
  const submitAction = session?.lastSubmitLikeAction;
  if (!submitAction) return false;
  if (submitAction.result?.submitted === true) return true;
  if (submitAction.result?.changed === false) return false;
  return hasSubmittedObservationSignal(observation);
}


function compactObservation(observation) {
  if (!observation || typeof observation !== 'object') return {};
  return {
    url: observation.url || '',
    title: observation.title || '',
    viewport: observation.viewport || null,
    pageText: asString(observation.pageText).slice(0, 3000),
    elements: asArray(observation.elements).slice(0, 80).map((el) => ({
      id: el.id,
      tag: el.tag,
      role: el.role,
      text: asString(el.text).slice(0, 120),
      value: asString(el.value).slice(0, 120),
      placeholder: asString(el.placeholder).slice(0, 120),
      name: asString(el.name).slice(0, 80),
      ariaLabel: asString(el.ariaLabel).slice(0, 120),
      className: asString(el.className).slice(0, 120),
      nearbyText: asString(el.nearbyText).slice(0, 180),
      type: el.type,
      editable: Boolean(el.editable),
      rect: el.rect,
      rectCenter: el.rectCenter,
      checked: el.checked
    }))
  };
}

function hasEditableElement(observation) {
  return asArray(observation?.elements).some((el) => el?.editable);
}

function countTypeActions(session) {
  return asArray(session?.history).filter((item) => item.role === 'model' && item.action?.action === 'type').length;
}

function buildFallbackTypeAction(capture, session, observation) {
  const answerType = answerTypeForCategory(capture?.categoryId);
  if (!['fill', 'subjective'].includes(answerType)) return null;

  const answers = fallbackAnswers(capture);
  if (!answers.length) return null;

  const editables = asArray(observation?.elements).filter((el) => el?.editable && el?.id);
  if (!editables.length) return null;

  const target = editables.find((el) => !asString(el.value)) || editables[0];
  const answerIndex = answerType === 'fill' ? Math.min(countTypeActions(session), answers.length - 1) : 0;
  const value = asString(answers[answerIndex] || answers[0]);
  if (!value) return null;

  return normalizeAction({
    action: 'type',
    target: { id: target.id },
    value,
    done: false,
    reason: 'fallback type into visible editable field'
  });
}

function buildAgentSystemPrompt() {
  return [
    'You are a GUI agent controlling an embedded classroom browser.',
    'You receive the solved question, a screenshot, and a visible DOM summary.',
    'Decide exactly one next browser action.',
    'Return only one JSON object. Do not return markdown, code fences, prose, or multiple actions.',
    '',
    'Allowed action schemas:',
    '{"action":"click","target":{"id":"ga-12"},"done":false,"reason":""}',
    '{"action":"type","target":{"id":"ga-20"},"value":"answer text","done":false,"reason":""}',
    '{"action":"wait","done":false,"reason":""}',
    '{"action":"finish","done":true,"reason":"submitted"}',
    '',
    'Target priority: use target.id from the DOM summary first. If no id fits, use target.text, then target.selector, then target.x/y coordinates.',
    'For type actions, if any element has editable:true, you must choose one editable element by target.id.',
    'Do not use x/y for type when an editable:true element is present in the DOM summary.',
    'Use x/y for type only when no editable:true element is present; x/y is safer for click actions than type actions.',
    'Never repeat the same click target or the same click coordinates after a no-change result. Choose a different target, wait, type into an editable field, or finish.',
    'For choice questions, click the option matching the solved answer key or text.',
    'For fill questions, type answers into blanks in order.',
    'For subjective questions, type the complete answer into the best text area/editor.',
    'For fill or subjective questions, clicking an answer/work/entry button only opens the answer area; it is not completion.',
    'After opening an answer area, if editable:true exists, the next action must be type into that editable target.id.',
    'After a successful type action, look for and click submit/confirm/finish rather than typing again.',
    'After the answer is selected or typed, click the submit/confirm/finish button.',
    'Only return finish after you clicked submit/confirm/finish for this question and the current page clearly shows this question was submitted.',
    'Never invent answers; use the provided solved answer and explanation.'
  ].join('\n');
}

function buildAgentUserText({ capture, renderedPrompt, observation, lastActionResult, recentActions, step }) {
  const p = capture?.payload || {};
  return [
    renderedPrompt,
    '',
    'Solved question:',
    JSON.stringify({
      categoryId: capture?.categoryId,
      categoryName: capture?.categoryName,
      answerType: answerTypeForCategory(capture?.categoryId),
      questionStem: p.questionStem || '',
      options: p.options || [],
      answers: p.answers || [],
      blanks: p.blanks || [],
      sampleAnswer: p.sampleAnswer || '',
      explanation: p.explanation || '',
      fallbackAnswers: fallbackAnswers(capture)
    }, null, 2),
    '',
    `Step: ${step}/${MAX_AGENT_STEPS}`,
    '',
    'Last action result:',
    JSON.stringify(lastActionResult || {}, null, 2),
    '',
    'Recent action signatures:',
    JSON.stringify(asArray(recentActions).slice(-5), null, 2),
    '',
    'Instruction: if the last action result has changed:false, do not repeat the same click target or coordinates.',
    'Instruction: if the last action result action is type and valueWritten is present, choose a submit/confirm/finish click next if available.',
    'Instruction: do not finish just because stale page text says submitted; finish only after this session clicked submit/confirm/finish.',
    hasEditableElement(observation)
      ? 'Instruction: editable:true elements are present. For type actions, use target.id of an editable:true element, not x/y coordinates.'
      : 'Instruction: no editable:true element is visible; coordinate type is allowed only as a fallback.',
    '',
    'Current browser observation:',
    JSON.stringify(compactObservation(observation), null, 2)
  ].filter(Boolean).join('\n');
}

export class GuiAgentService {
  constructor(config, state) {
    this.config = config;
    this.state = state;
    this.enabledOverride = null;
    this.apiKeyOverride = '';
    this.baseUrlOverride = '';
    this.modelOverride = '';
    this.promptTemplateOverride = '';
    this.pendingCommands = [];
    this.sessions = new Map();
    this.actionExecutor = null;
  }

  setActionExecutor(executor) {
    this.actionExecutor = typeof executor === 'function' ? executor : null;
  }

  updateSettings({ enabled, apiKey, baseUrl, model, promptTemplate } = {}) {
    if (enabled !== undefined) this.enabledOverride = Boolean(enabled);
    if (apiKey !== undefined) this.apiKeyOverride = asString(apiKey);
    if (baseUrl !== undefined) this.baseUrlOverride = asString(baseUrl);
    if (model !== undefined) this.modelOverride = asString(model);
    if (promptTemplate !== undefined) this.promptTemplateOverride = String(promptTemplate || '');
  }

  getApiKey() {
    return this.apiKeyOverride || this.config.openaiApiKey || '';
  }

  getBaseUrl() {
    return this.baseUrlOverride || this.config.openaiBaseUrl || 'https://api.openai.com/v1';
  }

  getSettings() {
    return {
      enabled: this.enabledOverride !== null ? this.enabledOverride : Boolean(this.config.guiAgentEnabled),
      apiKey: this.getApiKey(),
      baseUrl: this.getBaseUrl(),
      model: this.modelOverride || this.config.guiAgentModel || this.config.openaiModelFast || this.config.openaiModel || 'openai/gpt-5.5',
      promptTemplate: this.promptTemplateOverride || this.config.guiAgentPromptTemplate || ''
    };
  }

  isEnabled() {
    const settings = this.getSettings();
    return Boolean(settings.enabled && settings.apiKey);
  }

  async runForCapture(captureId) {
    const capture = this.state.findCapture(captureId);
    if (!capture) return null;

    if (!this.isEnabled()) {
      this.state.updateCapture(captureId, {
        guiAgentStatus: 'skipped',
        guiAgentRequest: '',
        guiAgentResponse: '',
        guiAgentError: 'GUI agent is disabled or missing OpenAI API Key'
      });
      return null;
    }

    if (!QUESTION_CATEGORY_IDS.has(Number(capture.categoryId))) {
      this.state.updateCapture(captureId, {
        guiAgentStatus: 'skipped',
        guiAgentRequest: '',
        guiAgentResponse: '',
        guiAgentError: 'Capture is not a question category'
      });
      return null;
    }

    if (this.actionExecutor) {
      const answerType = answerTypeForCategory(capture.categoryId);
      const answers = fallbackAnswers(capture);
      if (!answers.length) {
        this.state.updateCapture(captureId, {
          guiAgentStatus: 'skipped',
          guiAgentError: 'No submit-ready answer was found'
        });
        return null;
      }

      this.state.updateCapture(captureId, {
        guiAgentStatus: 'acting',
        guiAgentRequest: JSON.stringify({ answerType, answers }, null, 2),
        guiAgentResponse: '',
        guiAgentError: '',
        guiAgentTriggeredAt: new Date().toISOString()
      });

      try {
        await this.actionExecutor({ captureId, answerType, answers });
        this.state.updateCapture(captureId, {
          guiAgentStatus: 'done',
          guiAgentResponse: 'Submitted through Playwright fallback',
          guiAgentError: ''
        });
      } catch (error) {
        this.state.updateCapture(captureId, {
          guiAgentStatus: 'error',
          guiAgentError: error?.message || String(error)
        });
      }
      return { answerType, answers };
    }

    const session = {
      id: crypto.randomUUID(),
      captureId,
      step: 0,
      renderedPrompt: renderTemplate(this.getSettings().promptTemplate, capture),
      history: [],
      actionSignatures: [],
      pendingSubmitLikeAction: null,
      lastSubmitLikeAction: null,
      staleSubmittedSignalSeen: false,
      createdAt: new Date().toISOString()
    };

    this.sessions.set(session.id, session);
    this.state.updateCapture(captureId, {
      guiAgentStatus: 'observing',
      guiAgentRequest: '',
      guiAgentResponse: '',
      guiAgentError: '',
      guiAgentTriggeredAt: session.createdAt
    });
    this.enqueueObserve(session);
    return { sessionId: session.id };
  }

  enqueueObserve(session) {
    this.pendingCommands.push({
      id: crypto.randomUUID(),
      sessionId: session.id,
      captureId: session.captureId,
      type: 'observe',
      createdAt: new Date().toISOString()
    });
  }

  enqueueAction(session, action) {
    this.pendingCommands.push({
      id: crypto.randomUUID(),
      sessionId: session.id,
      captureId: session.captureId,
      type: 'act',
      action,
      createdAt: new Date().toISOString()
    });
  }

  takeNextCommand() {
    return this.pendingCommands.shift() || null;
  }

  async markCommandResult(commandId, result = {}) {
    if (!commandId) return;
    const session = this.sessions.get(result.sessionId);
    if (!session) return;

    if (!result.ok) {
      this.failSession(session, result.error || 'BrowserView command failed');
      return;
    }

    if (result.type === 'observe') {
      await this.handleObservation(session, result.observation || {});
      return;
    }

    if (result.type === 'act') {
      const actionResult = result.result || {};
      const action = lastModelAction(session);
      const submitLike = session.pendingSubmitLikeAction || isSubmitLikeAction(action) || isSubmitLikeResult(actionResult);
      session.history.push({ role: 'act_result', result: actionResult });
      if (submitLike) {
        session.lastSubmitLikeAction = {
          at: new Date().toISOString(),
          action,
          result: {
            action: actionResult.action || '',
            targetText: actionResult.targetText || '',
            targetId: actionResult.targetId || '',
            changed: actionResult.changed,
            submitted: actionResult.submitted === true
          }
        };
      }
      session.pendingSubmitLikeAction = null;
      if (result.done) {
        this.finishSession(session, 'done');
        return;
      }
      this.state.updateCapture(session.captureId, { guiAgentStatus: 'observing' });
      this.enqueueObserve(session);
    }
  }

  async handleObservation(session, observation) {
    const capture = this.state.findCapture(session.captureId);
    if (!capture) {
      this.sessions.delete(session.id);
      return;
    }

    session.step += 1;
    session.history.push({ role: 'observe', observation: compactObservation(observation) });

    if (session.step > MAX_AGENT_STEPS) {
      const recent = asArray(session.actionSignatures).slice(-3).join(', ');
      this.failSession(session, `GUI agent exceeded ${MAX_AGENT_STEPS} steps. Recent actions: ${recent || 'none'}`);
      return;
    }

    if (shouldAutoFinishAfterObservation(session, observation)) {
      this.finishSession(session, 'Detected submitted after submit click');
      return;
    }

    if (hasSubmittedObservationSignal(observation) && !session.lastSubmitLikeAction && !session.staleSubmittedSignalSeen) {
      session.staleSubmittedSignalSeen = true;
      session.history.push({
        role: 'debug',
        message: 'Ignored submitted-looking page text because this GUI agent session has not clicked submit.'
      });
    }

    this.state.updateCapture(session.captureId, { guiAgentStatus: 'thinking' });

    try {
      const { requestBody, rawResponse, action } = await this.decideNextAction({
        capture,
        session,
        observation,
        lastActionResult: session.history.slice().reverse().find((item) => item.role === 'act_result')?.result,
        recentActions: session.actionSignatures
      });

      session.history.push({ role: 'model', action, rawResponse });
      this.state.updateCapture(session.captureId, {
        guiAgentRequest: JSON.stringify(requestBody, null, 2),
        guiAgentResponse: rawResponse,
        guiAgentError: ''
      });

      const validationError = validateAction(action);
      if (validationError) {
        this.failSession(session, validationError);
        return;
      }

      const actionWarning = typeCoordinateWarning(action, observation);
      if (actionWarning) {
        session.history.push({ role: 'warning', warning: actionWarning });
        this.state.updateCapture(session.captureId, {
          guiAgentResponse: `${rawResponse}\n\n${actionWarning}`
        });
      }

      if (action.done || action.action === 'finish') {
        this.finishSession(session, action.reason || 'done');
        return;
      }

      if (isRepeatedNoProgressAction(session, action)) {
        this.failSession(session, `Repeated GUI action without progress: ${actionSignature(action)}`);
        return;
      }

      this.state.updateCapture(session.captureId, { guiAgentStatus: 'acting' });
      session.actionSignatures.push(actionSignature(action));
      session.actionSignatures = session.actionSignatures.slice(-8);
      session.pendingSubmitLikeAction = isSubmitLikeAction(action) ? {
        at: new Date().toISOString(),
        action
      } : null;
      this.enqueueAction(session, action);
    } catch (error) {
      this.failSession(session, error?.message || String(error), {
        debugResponse: error?.debugResponse || ''
      });
    }
  }

  async decideNextAction({ capture, session, observation, lastActionResult, recentActions }) {
    const settings = this.getSettings();
    const requestBody = this.buildStepRequest({
      capture,
      session,
      observation,
      lastActionResult,
      recentActions
    });

    const response = await this.fetchModelResponse(settings, requestBody);
    let parsed = this.parseActionFromModelResponse({
      responseText: response.responseText,
      recentActions,
      step: session.step,
      note: 'Initial GUI agent response did not contain a valid action JSON.'
    });

    if (!parsed.action) {
      const repairRequestBody = this.buildRepairRequest({
        requestBody,
        rawResponse: parsed.rawResponse,
        responseText: response.responseText
      });
      let repairedParsed = null;
      try {
        const repaired = await this.fetchModelResponse(settings, repairRequestBody);
        repairedParsed = this.parseActionFromModelResponse({
          responseText: repaired.responseText,
          recentActions,
          step: session.step,
          note: 'Repair GUI agent response still did not contain a valid action JSON.'
        });
      } catch (error) {
        repairedParsed = {
          rawResponse: '',
          action: null,
          debugResponse: [
            parsed.debugResponse,
            '',
            'Repair request failed:',
            error?.message || String(error)
          ].filter(Boolean).join('\n')
        };
      }

      if (repairedParsed.action) {
        return {
          requestBody: repairRequestBody,
          rawResponse: repairedParsed.rawResponse,
          action: repairedParsed.action
        };
      }

      const fallbackAction = buildFallbackTypeAction(capture, session, observation);
      if (fallbackAction) {
        return {
          requestBody: repairRequestBody,
          rawResponse: [
            repairedParsed.debugResponse,
            '',
            'Backend fallback action:',
            JSON.stringify(fallbackAction)
          ].filter(Boolean).join('\n'),
          action: fallbackAction
        };
      }

      throw new GuiAgentActionParseError(
        'GUI agent did not return valid JSON action',
        repairedParsed.debugResponse || parsed.debugResponse
      );
    }

    return {
      requestBody,
      rawResponse: parsed.rawResponse,
      action: parsed.action
    };
  }

  async fetchModelResponse(settings, requestBody) {
    const baseUrl = String(settings.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify(requestBody)
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`${resp.status} ${errText.slice(0, 500)}`.trim());
    }

    return { responseText: await resp.text() };
  }

  parseActionFromModelResponse({ responseText, recentActions, step, note }) {
    let rawResponse = '';
    try {
      rawResponse = parseModelResponseText(responseText);
    } catch {
      rawResponse = '';
    }
    const parsed = extractJson(rawResponse);
    const debugResponse = parsed ? '' : formatDebugResponse({
      rawResponse,
      responseText,
      recentActions,
      step,
      note
    });

    return {
      rawResponse,
      action: parsed ? normalizeAction(parsed) : null,
      debugResponse
    };
  }

  buildRepairRequest({ requestBody, rawResponse, responseText }) {
    return {
      ...requestBody,
      max_tokens: 300,
      messages: [
        ...requestBody.messages,
        {
          role: 'assistant',
          content: asString(rawResponse) || String(responseText || '').slice(0, 800) || '(empty response)'
        },
        {
          role: 'user',
          content: [
            'Your previous response was invalid.',
            'Return exactly one valid JSON action object now.',
            'Do not include markdown, prose, code fences, or multiple actions.',
            'Allowed actions are click, type, wait, finish.'
          ].join('\n')
        }
      ]
    };
  }

  buildStepRequest({ capture, session, observation, lastActionResult, recentActions }) {
    const userText = buildAgentUserText({
      capture,
      renderedPrompt: session.renderedPrompt,
      observation,
      lastActionResult,
      recentActions,
      step: session.step
    });

    const content = [];
    if (observation?.screenshot && /^data:image\//i.test(observation.screenshot)) {
      content.push({
        type: 'image_url',
        image_url: {
          url: observation.screenshot
        }
      });
    }
    content.push({ type: 'text', text: userText });

    return {
      model: this.getSettings().model,
      stream: true,
      temperature: 0.1,
      max_tokens: 900,
      messages: [
        { role: 'system', content: buildAgentSystemPrompt() },
        { role: 'user', content }
      ]
    };
  }

  finishSession(session, reason) {
    this.state.updateCapture(session.captureId, {
      guiAgentStatus: 'done',
      guiAgentError: '',
      guiAgentResponse: reason || 'done'
    });
    this.state.addLog('GUI agent finished BrowserView task');
    this.sessions.delete(session.id);
  }

  failSession(session, error, options = {}) {
    const patch = {
      guiAgentStatus: 'error',
      guiAgentError: error || 'GUI agent failed'
    };
    if (options.debugResponse !== undefined) {
      patch.guiAgentResponse = options.debugResponse || '';
    }
    this.state.updateCapture(session.captureId, patch);
    this.state.addLog(`GUI agent failed: ${error || 'unknown error'}`, 'warn');
    this.sessions.delete(session.id);
  }
}

