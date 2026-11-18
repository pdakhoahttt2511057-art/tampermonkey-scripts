// ==UserScript==
// @name         learn.eltngl.com
// @namespace    http://tampermonkey.net/
// @version      1.0.1
// @description  Tự giải bài tập ELTNGL bằng AI (Groq)
// @author       You
// @match        *://*.eltngl.com/*
// @match        *://*.cengage.com/*
// @all_frames   true
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      api.groq.com
// ==/UserScript==

(function() {
    'use strict';

    const AI_MODEL = "openai/gpt-oss-120b";
    const API_STORAGE_KEY = "eltngl_groq_api_key";
    const MEMORY_KEY = "eltngl_ai_mistake_memory_v29";

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const isTopWindow = (window.top === window.self);

    // --- QUẢN LÝ API KEY AN TOÀN ---
    function getOrPromptApiKey(forceNew = false) {
        let key = GM_getValue(API_STORAGE_KEY, "");
        if (!key || forceNew) {
            const msg = forceNew
                ? "Nhập Groq API Key mới của bạn (bắt đầu bằng gsk_...):"
                : "Chưa có Groq API Key. Vui lòng dán API Key của bạn vào đây (chỉ cần nhập 1 lần):";
            const input = prompt(msg, key);
            if (input !== null) {
                key = input.trim();
                GM_setValue(API_STORAGE_KEY, key);
            }
        }
        return key;
    }

    // --- BỘ NHỚ VĨNH VIỄN ---
    function getMistakes() {
        try {
            return JSON.parse(GM_getValue(MEMORY_KEY, "[]"));
        } catch (e) {
            return [];
        }
    }

    function saveMistake(contextSnippet, wrongAnswer) {
        if (!wrongAnswer || wrongAnswer.trim() === "") return;
        let mistakes = getMistakes();
        const cleanCtx = contextSnippet.replace(/\s+/g, ' ').trim();
        const cleanWrong = wrongAnswer.trim();

        const exists = mistakes.some(m => m.context === cleanCtx && m.wrong.toLowerCase() === cleanWrong.toLowerCase());
        if (!exists) {
            mistakes.push({ context: cleanCtx, wrong: cleanWrong });
            if (mistakes.length > 200) mistakes.shift();
            GM_setValue(MEMORY_KEY, JSON.stringify(mistakes));
        }
    }

    // --- QUÉT XUYÊN SHADOW DOM ---
    function querySelectorAllDeep(selector, root = document) {
        let results = [];
        try {
            results.push(...root.querySelectorAll(selector));
        } catch (e) {}

        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null, false);
        let node;
        while ((node = walker.nextNode())) {
            if (node.shadowRoot) {
                results.push(...querySelectorAllDeep(selector, node.shadowRoot));
            }
        }
        return results;
    }

    function isElementActive(elem) {
        if (!elem) return false;
        let curr = elem;
        for (let i = 0; i < 5 && curr && curr !== document.body; i++) {
            const style = window.getComputedStyle(curr);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            curr = curr.parentElement || (curr.getRootNode && curr.getRootNode().host);
        }
        const rect = elem.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return true;
        if (elem.parentElement) {
            const pRect = elem.parentElement.getBoundingClientRect();
            return pRect.width > 0 && pRect.height > 0;
        }
        return false;
    }

    function getExactGapBoundaries(el) {
        let sentenceBox = el.closest('p, li, .contentblock, [class*="item"], [class*="question"], [class*="sentence"]') || el.parentElement;
        if (!sentenceBox) return "Unknown sentence";

        let clone = sentenceBox.cloneNode(true);
        let allGaps = clone.querySelectorAll('input, select, button[role="combobox"], .listbox__label, [role="listbox"], .listbox, .om-text-gap__target-item, .textGapItem, .om-text-gap__droppable, .droppable');
        allGaps.forEach(gap => {
            if (!gap.parentElement.closest('.om-text-gap__target-item, .textGapItem, [role="listbox"], .listbox')) {
                let marker = document.createTextNode(" [___] ");
                if (gap.parentNode) gap.parentNode.replaceChild(marker, gap);
            }
        });
        return clone.innerText.replace(/\s+/g, ' ').trim().substring(0, 250);
    }

    function fillReactInput(element, value) {
        const prototype = element.tagName.toLowerCase() === 'select' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        if (nativeInputValueSetter) nativeInputValueSetter.call(element, value);
        else element.value = value;
        element.setAttribute('value', value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        element.dispatchEvent(new Event('blur', { bubbles: true }));
    }

    function simulateMouseClick(element) {
        if (!element) return;
        try {
            element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
            element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
            element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
            element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        } catch (e) {}

        if (typeof element.click === 'function') {
            element.click();
        } else {
            element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }
    }

    function simulateDragDrop(sourceNode, destinationNode) {
        simulateMouseClick(sourceNode);
        setTimeout(() => simulateMouseClick(destinationNode), 50);
    }

    function isMarkedWrong(el) {
        let wrapper = el.closest('.om-text-gap__target-item, .textGapItem, [role="listbox"], .listbox, [class*="choice"], [class*="input-radio"], [class*="input-checkbox"]') || el.parentElement;
        if (!wrapper) return false;
        const wrongRegex = /incorrect|wrong|cross|is-error|has-error|invalid|false|fail/i;
        const correctRegex = /correct|tick|check|valid|right/i;
        for (let node of [el, wrapper, wrapper.parentElement]) {
            if (!node) continue;
            const cls = typeof node.className === 'string' ? node.className : '';
            if (correctRegex.test(cls) && !wrongRegex.test(cls)) return false;
            if (wrongRegex.test(cls)) return true;
        }
        return wrapper.querySelector('[class*="cross"], [class*="incorrect"], [class*="wrong"], [aria-label*="incorrect" i]') !== null;
    }

    function learnLocalMistakes() {
        let learnedCount = 0;
        querySelectorAllDeep('input[type="text"], input.textGapItem__input, select').forEach(input => {
            if (isElementActive(input) && isMarkedWrong(input) && input.value.trim()) {
                saveMistake(getExactGapBoundaries(input), input.value.trim());
                learnedCount++;
            }
        });
        querySelectorAllDeep('button[role="combobox"], .listbox__label').forEach(combo => {
            if (isElementActive(combo) && isMarkedWrong(combo) && combo.innerText.trim()) {
                saveMistake(getExactGapBoundaries(combo), combo.innerText.trim());
                learnedCount++;
            }
        });
        querySelectorAllDeep('.om-text-gap__droppable, .droppable').forEach(zone => {
            if (isElementActive(zone) && isMarkedWrong(zone) && zone.innerText.trim()) {
                let val = zone.innerText.trim().split('\n')[0];
                if (val && val.length < 100) {
                    saveMistake(getExactGapBoundaries(zone), val);
                    learnedCount++;
                }
            }
        });
        return learnedCount;
    }

    let localAnswerGroups = [];
    let localDraggables = [];

    async function collectLocalQuestions() {
        localAnswerGroups = [];
        localDraggables = [];

        querySelectorAllDeep('input.textGapItem__input, input[type="text"], select').forEach(el => {
            if (isElementActive(el)) {
                localAnswerGroups.push({ type: 'standard', element: el, context: getExactGapBoundaries(el) });
            }
        });

        const comboboxes = querySelectorAllDeep('button[role="combobox"], .listbox__label, [aria-haspopup="listbox"]').filter(el => isElementActive(el));
        for (const combo of comboboxes) {
            const popupId = combo.getAttribute('aria-controls');
            let popup = popupId ? (document.getElementById(popupId) || querySelectorAllDeep(`#${CSS.escape(popupId)}`)[0]) : null;
            let wasClosed = combo.getAttribute('aria-expanded') !== 'true';

            if (!popup || wasClosed) {
                simulateMouseClick(combo);
                await sleep(70);
                popup = popupId ? (document.getElementById(popupId) || querySelectorAllDeep(`#${CSS.escape(popupId)}`)[0]) : querySelectorAllDeep('[role="listbox"]:not([hidden])')[0];
            }

            let options = [];
            if (popup) {
                options = Array.from(popup.querySelectorAll('[role="option"], li, .listbox__choice'))
                    .map(opt => opt.textContent.trim())
                    .filter(txt => txt !== "");
            }

            if (wasClosed && combo.getAttribute('aria-expanded') === 'true') {
                simulateMouseClick(combo);
                await sleep(30);
            }

            localAnswerGroups.push({
                type: 'portal_combobox',
                element: combo,
                options: options,
                context: getExactGapBoundaries(combo)
            });
        }

        let radioContainers = new Set();
        querySelectorAllDeep('div[role="radio"], div.input-radio, .is-radiobutton__icon').forEach(radio => {
            let cb = radio.closest('div[role="radio"], div.input-radio, label') || radio.parentElement;
            let container = cb && (cb.closest('[role="radiogroup"]') || cb.parentElement.parentElement);
            if (container && isElementActive(container)) radioContainers.add(container);
        });
        radioContainers.forEach(container => {
            let radios = Array.from(container.querySelectorAll('div[role="radio"], div.input-radio, label')).filter(el => el.querySelector('.is-radiobutton__icon') || el.getAttribute('role') === 'radio');
            if (radios.length > 0) {
                let opts = radios.map(r => {
                    let textSpan = r.querySelector('[class*="text"]');
                    return textSpan ? textSpan.textContent.trim() : r.textContent.replace(/^\.\s*/, '').trim();
                }).filter(v => v !== "");
                localAnswerGroups.push({ type: 'custom_radio', elements: radios, options: opts, context: getExactGapBoundaries(container) });
            }
        });

        let checkboxContainers = new Set();
        querySelectorAllDeep('div[role="checkbox"], div.input-checkbox, .is-checkbox__icon').forEach(checkbox => {
            let cb = checkbox.closest('div[role="checkbox"], div.input-checkbox, label') || checkbox.parentElement;
            let container = cb && (cb.closest('[role="group"]') || cb.parentElement.parentElement);
            if (container && isElementActive(container)) checkboxContainers.add(container);
        });
        checkboxContainers.forEach(container => {
            let checkboxes = Array.from(container.querySelectorAll('div[role="checkbox"], div.input-checkbox, label')).filter(el => el.querySelector('.is-checkbox__icon') || el.getAttribute('role') === 'checkbox');
            if (checkboxes.length > 0) {
                let opts = checkboxes.map(c => {
                    let textSpan = c.querySelector('[class*="text"]');
                    return textSpan ? textSpan.textContent.trim() : c.textContent.replace(/^\.\s*/, '').trim();
                }).filter(v => v !== "");
                localAnswerGroups.push({ type: 'custom_checkbox', elements: checkboxes, options: opts, context: getExactGapBoundaries(container) });
            }
        });

        localDraggables = querySelectorAllDeep('[draggable="true"], .draggable, .drag_item, .wordBox, .om-word-bank__item, [class*="draggable"]')
            .filter(el => isElementActive(el) && el.innerText.trim() !== "");

        querySelectorAllDeep('.om-text-gap__droppable, .droppable, .drop_area, [class*="droppable"]').forEach(zone => {
            if (isElementActive(zone) && !zone.querySelector('.om-text-gap__droppable, .droppable')) {
                localAnswerGroups.push({ type: 'drag_drop', element: zone, context: getExactGapBoundaries(zone) });
            }
        });

        const serializedFields = localAnswerGroups.map(g => {
            let opts = g.options || [];
            if (g.type === 'standard' && g.element.tagName.toLowerCase() === 'select') {
                opts = Array.from(g.element.options).map(o => o.value || o.text).filter(v => v.trim() !== "");
            }
            return {
                type: g.type,
                context: g.context,
                options: opts
            };
        });

        return {
            exerciseText: document.body ? document.body.innerText.substring(0, 5000) : "",
            dragWords: localDraggables.map(el => el.innerText.trim()),
            fields: serializedFields
        };
    }

    async function applyLocalAnswers(answers) {
        if (answers.length !== localAnswerGroups.length) return false;

        for (let i = 0; i < localAnswerGroups.length; i++) {
            let group = localAnswerGroups[i];
            let aiAnswers = Array.isArray(answers[i]) ? answers[i] : [answers[i]];

            for (const ans of aiAnswers) {
                let aiAnswerText = ans.toString().trim().toLowerCase();

                if (group.type === 'standard') {
                    let el = group.element;
                    if (el.tagName.toLowerCase() === 'select') {
                        let targetOpt = Array.from(el.options).find(o =>
                            o.value.toLowerCase().trim() === aiAnswerText ||
                            o.text.toLowerCase().trim() === aiAnswerText
                        );
                        fillReactInput(el, targetOpt ? targetOpt.value : ans);
                    } else {
                        fillReactInput(el, ans);
                    }
                } else if (group.type === 'portal_combobox') {
                    const combo = group.element;
                    const popupId = combo.getAttribute('aria-controls');
                    if (combo.getAttribute('aria-expanded') !== 'true') {
                        simulateMouseClick(combo);
                        await sleep(70);
                    }
                    const popup = popupId ? (document.getElementById(popupId) || querySelectorAllDeep(`#${CSS.escape(popupId)}`)[0]) : querySelectorAllDeep('[role="listbox"]')[0];
                    if (popup) {
                        const targetOpt = Array.from(popup.querySelectorAll('[role="option"], li, .listbox__choice'))
                            .find(opt => opt.textContent.trim().toLowerCase() === aiAnswerText);
                        if (targetOpt) {
                            simulateMouseClick(targetOpt);
                            await sleep(50);
                        }
                    }
                } else if (group.type === 'custom_radio' || group.type === 'custom_checkbox') {
                    let targetItem = group.elements.find(el => {
                        let textSpan = el.querySelector('[class*="text"]');
                        let txt = textSpan ? textSpan.textContent.trim() : el.textContent.replace(/^\.\s*/, '').trim();
                        return txt.toLowerCase() === aiAnswerText;
                    });
                    if (targetItem) {
                        let clickTarget = targetItem.querySelector('.is-radiobutton__icon, .is-checkbox__icon') || targetItem;
                        simulateMouseClick(clickTarget);
                    }
                } else if (group.type === 'drag_drop') {
                    let targetSource = localDraggables.find(el => el.innerText.trim().toLowerCase() === aiAnswerText);
                    if (targetSource) {
                        simulateDragDrop(targetSource, group.element);
                    }
                }
            }
        }
        return true;
    }

    window.addEventListener("message", async (event) => {
        if (!event.data || event.data.source !== "ELTNGL_AI_HELPER") return;

        if (event.data.action === "LEARN_MISTAKES") {
            const count = learnLocalMistakes();
            window.top.postMessage({ source: "ELTNGL_AI_HELPER", action: "LEARN_RESULT", count }, "*");
        } else if (event.data.action === "SCAN_QUESTIONS") {
            learnLocalMistakes();
            const payload = await collectLocalQuestions();
            if (payload.fields.length > 0) {
                window.top.postMessage({
                    source: "ELTNGL_AI_HELPER",
                    action: "SCAN_RESULT",
                    frameId: event.data.frameId,
                    payload: payload
                }, "*");
            }
        } else if (event.data.action === "APPLY_ANSWERS") {
            await applyLocalAnswers(event.data.answers);
        }
    });

    if (!isTopWindow) return;

    function showAnswersOverlay(answers, title = "💡 Gợi ý Đáp án") {
        let overlay = document.getElementById("ai-answer-overlay");
        if (!overlay) {
            overlay = document.createElement("div");
            overlay.id = "ai-answer-overlay";
            overlay.style = "position:fixed; top:20px; right:20px; z-index:10000; background:rgba(0,0,0,0.88); color:white; padding:15px; border-radius:8px; max-width: 320px; max-height: 80vh; overflow-y: auto; font-family: sans-serif; box-shadow: 0 4px 10px rgba(0,0,0,0.5);";
            document.body.appendChild(overlay);
        }
        let html = '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">';
        html += `<h3 style="margin:0; font-size:16px; color:#4CAF50;">${title}</h3>`;
        html += '<button onclick="this.parentElement.parentElement.remove()" style="background:none; border:none; color:white; cursor:pointer; font-size:16px;">✖</button>';
        html += '</div><ul style="list-style:decimal; padding-left:20px; margin:0; font-size:14px; line-height:1.5;">';

        answers.forEach(ans => {
            let text = Array.isArray(ans) ? ans.join(", ") : ans;
            html += `<li style="margin-bottom:5px;"><b>${text}</b></li>`;
        });
        html += '</ul>';
        overlay.innerHTML = html;
    }

    const btnContainer = document.createElement("div");
    btnContainer.style = "position:fixed; bottom:20px; left:20px; z-index:9999; display:flex; gap:8px;";
    document.body.appendChild(btnContainer);

    const btn = document.createElement("button");
    btn.innerHTML = "✨ Giải V29.4";
    btn.style = "padding:10px 15px; background:#F55036; color:white; border:none; border-radius:5px; font-weight:bold; cursor:pointer; box-shadow: 0px 4px 6px rgba(0,0,0,0.3);";
    btnContainer.appendChild(btn);

    const learnBtn = document.createElement("button");
    learnBtn.innerHTML = `🧠 Đã nhớ (${getMistakes().length})`;
    learnBtn.style = "padding:10px 12px; background:#2b3137; color:white; border:none; border-radius:5px; font-weight:bold; cursor:pointer; box-shadow: 0px 4px 6px rgba(0,0,0,0.3);";
    btnContainer.appendChild(learnBtn);

    const clearBtn = document.createElement("button");
    clearBtn.innerHTML = "🗑️";
    clearBtn.title = "Xóa bộ nhớ câu sai";
    clearBtn.style = "padding:10px; background:#555; color:white; border:none; border-radius:5px; cursor:pointer;";
    btnContainer.appendChild(clearBtn);

    const keyBtn = document.createElement("button");
    keyBtn.innerHTML = "🔑";
    keyBtn.title = "Đổi Groq API Key";
    keyBtn.style = "padding:10px; background:#0066cc; color:white; border:none; border-radius:5px; cursor:pointer;";
    btnContainer.appendChild(keyBtn);

    keyBtn.addEventListener("click", () => {
        const updatedKey = getOrPromptApiKey(true);
        if (updatedKey) {
            alert("✅ Đã cập nhật Groq API Key mới thành công!");
        }
    });

    clearBtn.addEventListener("click", () => {
        if (confirm("Xóa toàn bộ trí nhớ về các câu làm sai?")) {
            GM_setValue(MEMORY_KEY, "[]");
            learnBtn.innerHTML = "🧠 Đã nhớ (0)";
            alert("Đã xóa sạch bộ nhớ!");
        }
    });

    function broadcastToAllFrames(messageObj) {
        const iframes = document.querySelectorAll('iframe');
        iframes.forEach((iframe, idx) => {
            try {
                iframe.contentWindow.postMessage({ ...messageObj, frameId: idx }, "*");
            } catch (e) {}
        });
    }

    learnBtn.addEventListener("click", async () => {
        let localLearned = learnLocalMistakes();
        let iframeLearned = 0;

        const listener = (e) => {
            if (e.data && e.data.source === "ELTNGL_AI_HELPER" && e.data.action === "LEARN_RESULT") {
                iframeLearned += e.data.count;
            }
        };
        window.addEventListener("message", listener);
        broadcastToAllFrames({ source: "ELTNGL_AI_HELPER", action: "LEARN_MISTAKES" });
        await sleep(300);
        window.removeEventListener("message", listener);

        const totalNew = localLearned + iframeLearned;
        learnBtn.innerHTML = `🧠 Đã nhớ (${getMistakes().length})`;
        alert(totalNew > 0 ? `✅ Đã lưu ${totalNew} lỗi sai mới!` : "Không phát hiện câu sai mới.");
    });

    btn.addEventListener("click", async () => {
        const currentApiKey = getOrPromptApiKey(false);
        if (!currentApiKey) {
            alert("⚠️ Bạn cần nhập Groq API Key để sử dụng tính năng giải bài!");
            return;
        }

        btn.innerHTML = "⏳ Đang quét...";
        btn.disabled = true;

        learnLocalMistakes();
        let activeTarget = null;
        let localData = await collectLocalQuestions();

        if (localData.fields.length > 0) {
            activeTarget = { isLocal: true, data: localData };
        } else {
            activeTarget = await new Promise((resolve) => {
                const handler = (e) => {
                    if (e.data && e.data.source === "ELTNGL_AI_HELPER" && e.data.action === "SCAN_RESULT") {
                        window.removeEventListener("message", handler);
                        resolve({ isLocal: false, sourceWindow: e.source, data: e.data.payload });
                    }
                };
                window.addEventListener("message", handler);
                broadcastToAllFrames({ source: "ELTNGL_AI_HELPER", action: "SCAN_QUESTIONS" });

                setTimeout(() => {
                    window.removeEventListener("message", handler);
                    resolve(null);
                }, 1200);
            });
        }

        const allMistakes = getMistakes();
        learnBtn.innerHTML = `🧠 Đã nhớ (${allMistakes.length})`;

        if (!activeTarget || activeTarget.data.fields.length === 0) {
            alert("Không tìm thấy câu hỏi nào trên màn hình!");
            return resetBtn();
        }

        const { exerciseText, dragWords, fields } = activeTarget.data;

        let optionsContext = "\nFIELDS TO FILL (Replace ONLY '[___]'):\n";
        if (dragWords.length > 0) optionsContext += `Word Bank: [${dragWords.join(" | ")}]\n`;

        fields.forEach((field, index) => {
            optionsContext += `Field ${index + 1}: "${field.context}"`;

            let fieldMistakes = allMistakes.filter(m => m.context === field.context);
            if (fieldMistakes.length > 0) {
                let wrongList = fieldMistakes.map(m => `"${m.wrong}"`).join(", ");
                optionsContext += `\n[CRITICAL ERROR: Previously answered ${wrongList} and it was WRONG. Do NOT repeat!]`;
            }

            if (field.options && field.options.length > 0) {
                optionsContext += ` -> Options (return exact option text): [${field.options.join(", ")}]`;
            }
            optionsContext += "\n";
        });

        const prompt = `
        You are an expert English teacher. Solve this exercise accurately:
        """${exerciseText}"""
        ${optionsContext}

        RULES:
        1. Read the exact text outside '[___]' to prevent duplicating words.
        2. When Options are listed, return the EXACT matching option string (e.g., "a", "b", "c", "d", "e", "f").
        3. NEVER output any answer listed in [CRITICAL ERROR].
        4. Return ONLY a raw JSON array of strings (or arrays of strings for checkboxes) matching the ${fields.length} fields in order. No markdown, no explanations.
        `;

        btn.innerHTML = `⏳ AI đang nghĩ (${fields.length})...`;

        GM_xmlhttpRequest({
            method: "POST",
            url: "https://api.groq.com/openai/v1/chat/completions",
            headers: {
                "Authorization": `Bearer ${currentApiKey}`,
                "Content-Type": "application/json"
            },
            data: JSON.stringify({
                model: AI_MODEL,
                messages: [{ role: "user", content: prompt }],
                temperature: 0.1,
                max_tokens: 1500
            }),
            onload: async function(response) {
                try {
                    const result = JSON.parse(response.responseText);
                    if (result.error) {
                        alert("Lỗi API: " + result.error.message);
                        return resetBtn();
                    }

                    let aiText = result.choices[0].message.content || "";
                    aiText = aiText.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

                    const jsonMatch = aiText.match(/\[[\s\S]*\]/);

                    if (jsonMatch) {
                        const answers = JSON.parse(jsonMatch[0]);
                        showAnswersOverlay(answers);

                        if (answers.length === fields.length) {
                            if (activeTarget.isLocal) {
                                await applyLocalAnswers(answers);
                            } else {
                                activeTarget.sourceWindow.postMessage({
                                    source: "ELTNGL_AI_HELPER",
                                    action: "APPLY_ANSWERS",
                                    answers: answers
                                }, "*");
                            }
                            btn.innerHTML = "✅ Xong!";
                        } else {
                            showAnswersOverlay(answers, "⚠️ Đáp án (Hãy điền tay)");
                            btn.innerHTML = "⚠️ Lệch ô";
                        }
                        setTimeout(() => resetBtn(), 2000);
                    } else {
                        alert("Lỗi đọc JSON từ AI. Phản hồi nhận được:\n" + aiText.substring(0, 200));
                        resetBtn();
                    }
                } catch (e) {
                    console.error(e);
                    resetBtn();
                }
            },
            onerror: function() {
                alert("Lỗi kết nối Groq.");
                resetBtn();
            }
        });
    });

    function resetBtn() {
        btn.innerHTML = "✨ Giải V29.4";
        btn.disabled = false;
    }
})();
