const contentProtocol = "gesture-slides-action-v133";

function isVisible(element) {
  const bounds = element.getBoundingClientRect();
  return bounds.width > 0 && bounds.height > 0;
}

function controlLabel(element) {
  return [
    element.getAttribute("aria-label"),
    element.getAttribute("title"),
    element.getAttribute("data-tooltip"),
  ]
    .filter(Boolean)
    .join(" ")
    .trim();
}

function slideNumberFromLabel(label) {
  const match = /^\s*(?:slide\s*)?(\d+)(?:\s*[:.-].*)?\s*$/i.exec(
    label.replace(/\s+/g, " "),
  );
  return match ? Number(match[1]) : undefined;
}

function thumbnailTarget(element) {
  let current = element;
  for (let depth = 0; current && current !== document.body && depth < 8; depth += 1) {
    if (!isVisible(current)) {
      current = current.parentElement;
      continue;
    }

    const bounds = current.getBoundingClientRect();
    if (
      current.getAttribute("role") === "option" ||
      (bounds.width >= 60 &&
        bounds.height >= 40 &&
        bounds.width <= 320 &&
        bounds.height <= 240)
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return undefined;
}

function findControl(labelPattern) {
  return Array.from(
    document.querySelectorAll('button, [role="button"], [role="menuitem"]'),
  ).find(
    (element) =>
      isVisible(element) && labelPattern.test(controlLabel(element)),
  );
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function hasSelectedState(element) {
  return (
    element.getAttribute("aria-selected") === "true" ||
    element.getAttribute("aria-pressed") === "true" ||
    element.getAttribute("data-selected") === "true" ||
    element.getAttribute("aria-current") === "true" ||
    /\b(selected|current)\b/i.test(String(element.className))
  );
}

async function waitForSelection(thumbnail, previousHash) {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    let element = thumbnail;
    while (element && element !== document.body) {
      if (hasSelectedState(element)) {
        return true;
      }
      element = element.parentElement;
    }
    if (window.location.hash !== previousHash) {
      return true;
    }
    await wait(50);
  }
  return false;
}

function findSlideThumbnail(slideNumber) {
  const candidates = Array.from(document.querySelectorAll("*"))
    .filter((element) => {
      if (!isVisible(element)) {
        return false;
      }

      const accessibleLabel = controlLabel(element);
      const textLabel =
        element.children.length === 0 && element.textContent.length < 40
          ? element.textContent.trim()
          : "";
      return (
        slideNumberFromLabel(accessibleLabel) === slideNumber ||
        slideNumberFromLabel(textLabel) === slideNumber
      );
    })
    .map(thumbnailTarget)
    .filter(Boolean);
  const uniqueCandidates = [...new Set(candidates)];
  const thumbnail = uniqueCandidates.sort((first, second) => {
    const firstBounds = first.getBoundingClientRect();
    const secondBounds = second.getBoundingClientRect();
    const firstOption = Number(first.getAttribute("role") === "option");
    const secondOption = Number(second.getAttribute("role") === "option");
    if (firstOption !== secondOption) {
      return secondOption - firstOption;
    }
    return (
      secondBounds.width * secondBounds.height -
      firstBounds.width * firstBounds.height
    );
  })[0];
  return thumbnail;
}

async function showFilmstripIfHidden() {
  const viewMenu = findControl(/^view(?: menu)?$/i);
  if (!viewMenu) {
    return false;
  }

  const viewBounds = viewMenu.getBoundingClientRect();
  await sendTrustedAction({
    type: "click",
    purpose: "open-view-menu",
    x: viewBounds.left + viewBounds.width / 2,
    y: viewBounds.top + viewBounds.height / 2,
  });
  await wait(150);

  const showFilmstrip = findControl(/show filmstrip/i);
  if (!showFilmstrip) {
    await sendTrustedAction({
      type: "click",
      purpose: "close-view-menu",
      x: viewBounds.left + viewBounds.width / 2,
      y: viewBounds.top + viewBounds.height / 2,
    });
    return false;
  }

  const bounds = showFilmstrip.getBoundingClientRect();
  await sendTrustedAction({
    type: "click",
    purpose: "show-filmstrip",
    x: bounds.left + bounds.width / 2,
    y: bounds.top + bounds.height / 2,
  });
  await wait(400);
  return true;
}

async function selectSlide(slideNumber) {
  let thumbnail = findSlideThumbnail(slideNumber);
  if (!thumbnail && (await showFilmstripIfHidden())) {
    thumbnail = findSlideThumbnail(slideNumber);
  }

  if (!thumbnail) {
    const foundLabels = Array.from(
      document.querySelectorAll("*"),
    )
      .filter((element) => {
        const label = controlLabel(element);
        return (
          /\bslide\b/i.test(label) &&
          (label.match(/\S+/g)?.length ?? 0) <= 12
        );
      })
      .slice(0, 20)
      .map((element) => {
        const bounds = element.getBoundingClientRect();
        const label = controlLabel(element);
        return `${label} (${Math.round(bounds.width)}x${Math.round(bounds.height)}, visible: ${isVisible(element)})`;
      });
    throw new Error(
      foundLabels.length
        ? `Could not find slide ${slideNumber}. Google Slides labels found: ${foundLabels.join("; ")}`
        : "Could not find slide thumbnails. Make sure the Google Slides editor is open with the filmstrip visible.",
    );
  }

  thumbnail.scrollIntoView({ block: "nearest" });
  const bounds = thumbnail.getBoundingClientRect();
  const previousHash = window.location.hash;
  const label =
    controlLabel(thumbnail) ||
    (thumbnail.textContent.length < 40 ? thumbnail.textContent.trim() : "") ||
    `Slide ${slideNumber}`;
  await sendTrustedAction({
    type: "click",
    purpose: "select-slide",
    slideNumber,
    x: bounds.left + bounds.width / 2,
    y: bounds.top + bounds.height / 2,
  });
  if (!(await waitForSelection(thumbnail, previousHash))) {
    throw new Error(
      `Clicked "${label || "slide thumbnail"}" at ${Math.round(bounds.width)}x${Math.round(bounds.height)}, but Google Slides did not confirm a selection (URL fragment: ${previousHash || "none"}). Make sure the presentation is in edit mode and the slide filmstrip is visible.`,
    );
  }
  return `Selected slide ${slideNumber}.`;
}

async function performGestureAction(action) {
  if (action === "start") {
    const presentButton = findControl(
      /^(present|start slideshow|start presentation)(?:\b|$)/i,
    );
    if (!presentButton) {
      throw new Error(
        "Could not find the Present control. Make sure the presentation is open in edit mode.",
      );
    }
    const bounds = presentButton.getBoundingClientRect();
    return sendTrustedAction({
      type: "start",
      x: bounds.left + bounds.width / 2,
      y: bounds.top + bounds.height / 2,
    });
  }

  if (action === "exit") {
    if (/\/present(?:\/|$)/.test(window.location.pathname)) {
      return sendTrustedAction({ type: "exit" });
    }

    const exitButton = findControl(
      /^(exit slideshow|close presentation|exit presentation|exit full screen)(?:\b|$)/i,
    );
    if (exitButton) {
      exitButton.click();
      return "Clicked the slideshow exit control.";
    }
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return "Exited fullscreen presentation.";
    }
    throw new Error(
      "Could not find the slideshow exit control in this tab. Make sure the slideshow is open in this tab.",
    );
  }

  const match = /^slide:(\d+)$/.exec(action);
  if (!match) {
    throw new Error("The requested gesture action is not recognized.");
  }

  const slideNumber = Number(match[1]);
  if (slideNumber < 1 || slideNumber > 10) {
    throw new Error("Slide gestures support slide numbers 1 through 10.");
  }

  if (/\/present(?:\/|$)/.test(window.location.pathname)) {
    return sendTrustedAction({ type: "navigate", slideNumber });
  }

  return selectSlide(slideNumber);
}

async function sendTrustedAction(action) {
  const response = await chrome.runtime.sendMessage({
    type: "gesture-slides-trusted-action",
    action,
  });
  if (!response?.ok) {
    throw new Error(response?.error ?? "Could not control the slideshow.");
  }
  return response;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== contentProtocol) {
    return false;
  }

  performGestureAction(message.action)
    .then((result) =>
      sendResponse({
        ok: true,
        contentProtocol,
        ...(typeof result === "string" ? { message: result } : result),
      }),
    )
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  return true;
});
