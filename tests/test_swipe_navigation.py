import unittest

from swipe_navigation import (
    SwipeNavigation,
    is_right_swipe_hand,
    left_hand_index,
    physical_hand_side,
)


class SwipeNavigationTests(unittest.TestCase):
    def test_normalizes_mediapipe_handedness_for_camera_mirroring(self):
        self.assertTrue(is_right_swipe_hand("Left"))
        self.assertFalse(is_right_swipe_hand("Right"))
        self.assertTrue(is_right_swipe_hand("Right", image_is_mirrored=True))
        self.assertFalse(is_right_swipe_hand("Left", image_is_mirrored=True))
        self.assertEqual(physical_hand_side("Left"), "Right")
        self.assertEqual(physical_hand_side("Right", image_is_mirrored=True), "Right")
        self.assertIsNone(physical_hand_side("Unknown"))

    def test_selects_only_the_physical_left_hand_for_gestures(self):
        self.assertEqual(left_hand_index(["Right", "Left"]), 1)
        self.assertIsNone(left_hand_index(["Right", None]))

    def test_detects_left_and_right_from_index_tip_position(self):
        detector = SwipeNavigation()
        self.assertIsNone(detector.update(0.7, 0.0, is_right_hand=True))
        self.assertEqual(detector.update(0.6, 0.1, is_right_hand=True), "left")

        detector = SwipeNavigation()
        self.assertIsNone(detector.update(0.2, 0.0, is_right_hand=True))
        self.assertEqual(detector.update(0.3, 0.1, is_right_hand=True), "right")

    def test_ignores_left_hand_and_movement_below_threshold(self):
        detector = SwipeNavigation()
        detector.update(0.2, 0.0, is_right_hand=False)
        self.assertIsNone(detector.update(0.5, 0.1, is_right_hand=False))

        detector = SwipeNavigation()
        detector.update(0.2, 0.0, is_right_hand=True)
        self.assertIsNone(detector.update(0.25, 0.1, is_right_hand=True))

    def test_one_swipe_fires_once_until_hand_settles(self):
        detector = SwipeNavigation()
        detector.update(0.2, 0.0, is_right_hand=True)
        self.assertEqual(detector.update(0.3, 0.1, is_right_hand=True), "right")
        self.assertIsNone(detector.update(0.4, 0.2, is_right_hand=True))
        self.assertIsNone(detector.update(0.4, 0.8, is_right_hand=True))
        self.assertIsNone(detector.update(0.4, 1.0, is_right_hand=True))
        self.assertFalse(detector.swipe_suppressed)
        self.assertEqual(detector.update(0.3, 1.1, is_right_hand=True), "left")

    def test_rearms_after_right_hand_is_removed(self):
        detector = SwipeNavigation()
        detector.update(0.2, 0.0, is_right_hand=True)
        detector.update(0.3, 0.1, is_right_hand=True)
        detector.update(None, 0.2, is_right_hand=False)
        detector.update(None, 0.91, is_right_hand=False)
        self.assertFalse(detector.swipe_suppressed)


if __name__ == "__main__":
    unittest.main()
