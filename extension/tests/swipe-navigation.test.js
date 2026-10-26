import assert from "node:assert/strict";
import test from "node:test";
import {
  actionForHandPoses,
  isRightSwipeHand,
  physicalHandSide,
  SwipeNavigation,
} from "../src/swipe-navigation.js";

test("normalizes handedness for mirrored and unmirrored camera frames", () => {
  assert.equal(isRightSwipeHand("Left"), true);
  assert.equal(isRightSwipeHand("Right"), false);
  assert.equal(isRightSwipeHand("Right", true), true);
  assert.equal(isRightSwipeHand("Left", true), false);
  assert.equal(physicalHandSide("Left"), "Right");
  assert.equal(physicalHandSide("Right", true), "Right");
  assert.equal(physicalHandSide("other"), undefined);
});

test("only the physical left hand can trigger a gesture", () => {
  assert.equal(
    actionForHandPoses([{ side: "Right", fingers: [0, 1, 0, 0, 0] }]),
    undefined,
  );
  assert.equal(
    actionForHandPoses([
      { side: "Right", fingers: [0, 0, 0, 0, 0] },
      { side: "Left", fingers: [0, 1, 0, 0, 0] },
    ]),
    "slide:1",
  );
  assert.equal(
    actionForHandPoses([{ side: "Left", fingers: [0, 0, 0, 0, 0] }]),
    "exit",
  );
  assert.equal(
    actionForHandPoses([
      { side: "Left", fingers: [1, 1, 1, 1, 1] },
      { side: "Right", fingers: [1, 1, 1, 1, 1] },
    ]),
    "start",
  );
});

test("preserves the slide-three thumb-direction distinction", () => {
  const landmarks = Array.from({ length: 21 }, () => ({ x: 0, y: 0 }));
  landmarks[9] = { x: 0, y: 1 };
  landmarks[1] = { x: 0, y: 0 };
  landmarks[4] = { x: 1, y: 0 };
  assert.equal(
    actionForHandPoses([
      { side: "Left", fingers: [1, 1, 1, 1, 0], landmarks },
    ]),
    "slide:3",
  );
  assert.equal(
    actionForHandPoses([{ side: "Left", fingers: [1, 1, 1, 1, 0] }]),
    "slide:9",
  );
});

test("detects left and right swipes from index-tip movement", () => {
  const leftSwipe = new SwipeNavigation();
  leftSwipe.update(0.7, 0, true);
  assert.equal(leftSwipe.update(0.6, 100, true), "left");

  const rightSwipe = new SwipeNavigation();
  rightSwipe.update(0.2, 0, true);
  assert.equal(rightSwipe.update(0.3, 100, true), "right");
});

test("ignores left-hand movement and movement below the threshold", () => {
  const detector = new SwipeNavigation();
  detector.update(0.2, 0, false);
  assert.equal(detector.update(0.5, 100, false), undefined);

  const smallMovement = new SwipeNavigation();
  smallMovement.update(0.2, 0, true);
  assert.equal(smallMovement.update(0.25, 100, true), undefined);
});

test("one swipe fires once until the hand settles", () => {
  const detector = new SwipeNavigation();
  detector.update(0.2, 0, true);
  assert.equal(detector.update(0.3, 100, true), "right");
  assert.equal(detector.update(0.4, 200, true), undefined);
  assert.equal(detector.update(0.4, 800, true), undefined);
  assert.equal(detector.update(0.4, 1000, true), undefined);
  assert.equal(detector.swipeSuppressed, false);
  assert.equal(detector.update(0.3, 1100, true), "left");
});

test("rearms after the right hand is removed", () => {
  const detector = new SwipeNavigation();
  detector.update(0.2, 0, true);
  detector.update(0.3, 100, true);
  detector.update(undefined, 200, false);
  detector.update(undefined, 910, false);
  assert.equal(detector.swipeSuppressed, false);
});
