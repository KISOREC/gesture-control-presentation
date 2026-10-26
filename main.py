import cv2
import math
import mediapipe as mp
import pyautogui
import time
from mediapipe.tasks.python import vision
from swipe_navigation import SwipeNavigation, left_hand_index, physical_hand_side
import os
import sys

# Resolve the hand landmark model relative to this script so execution is cwd-independent.
# Get the model path
model_path = os.path.join(os.path.dirname(__file__), "models/hand_landmarker.task")

if not os.path.exists(model_path):
    print(f"Error: Model file not found at {model_path}")
    print("Please run: python3 setup_models.py")
    exit(1)

# Detect both hands so a two-open-palm gesture can start the slideshow.
base_options = mp.tasks.BaseOptions(model_asset_path=model_path)
options = vision.HandLandmarkerOptions(
    base_options=base_options,
    num_hands=2,
    min_hand_detection_confidence=0.7,
    min_hand_presence_confidence=0.7,
    min_tracking_confidence=0.7
)
hand_landmarker = vision.HandLandmarker.create_from_options(options)

# Open the default webcam (index 0).
cap = cv2.VideoCapture(0)

candidate_action = None
candidate_since = 0
last_action = None
no_gesture_since = None
stable_gesture_time = 0.7
release_gesture_time = 0.7
swipe_navigation = SwipeNavigation()

def fingers_up(hand_landmarks):
    """Classify extended fingers independently of the hand's image rotation."""
    def distance(first, second):
        return (
            (first.x - second.x) ** 2
            + (first.y - second.y) ** 2
        ) ** 0.5

    def joint_angle(first, joint, last):
        first_vector = (first.x - joint.x, first.y - joint.y)
        last_vector = (last.x - joint.x, last.y - joint.y)
        first_length = (first_vector[0] ** 2 + first_vector[1] ** 2) ** 0.5
        last_length = (last_vector[0] ** 2 + last_vector[1] ** 2) ** 0.5
        if first_length == 0 or last_length == 0:
            return 0
        cosine = (
            first_vector[0] * last_vector[0]
            + first_vector[1] * last_vector[1]
        ) / (first_length * last_length)
        cosine = max(-1.0, min(1.0, cosine))
        return math.degrees(math.acos(cosine))

    wrist = hand_landmarks[0]
    middle_mcp = hand_landmarks[9]
    palm_axis_x = middle_mcp.x - wrist.x
    palm_axis_y = middle_mcp.y - wrist.y
    palm_length = (palm_axis_x ** 2 + palm_axis_y ** 2) ** 0.5
    if palm_length == 0:
        return [0, 0, 0, 0, 0]

    thumb_is_up = (
        joint_angle(
            hand_landmarks[2],
            hand_landmarks[3],
            hand_landmarks[4],
        ) >= 145
        and distance(hand_landmarks[1], hand_landmarks[4]) > 0.35 * palm_length
    )

    finger_joints = [
        (8, 7, 6, 5),
        (12, 11, 10, 9),
        (16, 15, 14, 13),
        (20, 19, 18, 17),
    ]
    fingers = [int(thumb_is_up)]

    for tip, dip, pip, mcp in finger_joints:
        tip_forward = (
            (hand_landmarks[tip].x - hand_landmarks[mcp].x) * palm_axis_x
            + (hand_landmarks[tip].y - hand_landmarks[mcp].y) * palm_axis_y
        ) / palm_length
        fingers.append(
            int(
                joint_angle(
                    hand_landmarks[mcp],
                    hand_landmarks[pip],
                    hand_landmarks[dip],
                ) >= 145
                and tip_forward > 0.15 * palm_length
            )
        )

    return fingers


def slide_for_gesture(fingers, hand_landmarks=None):
    """Map the photographed finger poses to slide numbers 1 through 10."""
    if tuple(fingers) == (1, 1, 1, 1, 0) and hand_landmarks is not None:
        wrist = hand_landmarks[0]
        middle_mcp = hand_landmarks[9]
        thumb_base = hand_landmarks[1]
        thumb_tip = hand_landmarks[4]
        palm_axis = (middle_mcp.x - wrist.x, middle_mcp.y - wrist.y)
        thumb_axis = (thumb_tip.x - thumb_base.x, thumb_tip.y - thumb_base.y)
        palm_length = math.hypot(*palm_axis)
        thumb_length = math.hypot(*thumb_axis)

        if palm_length and thumb_length:
            thumb_side = (
                palm_axis[0] * thumb_axis[1]
                - palm_axis[1] * thumb_axis[0]
            ) / (palm_length * thumb_length)
            if thumb_side < -0.2:
                return 3

    gestures = {
        (0, 1, 0, 0, 0): 1,
        (0, 1, 1, 0, 0): 2,
        (0, 1, 1, 1, 0): 3,
        (0, 1, 1, 1, 1): 4,
        (1, 1, 1, 1, 1): 5,
        (1, 0, 0, 0, 0): 6,
        (1, 1, 0, 0, 0): 7,
        (1, 1, 1, 0, 0): 8,
        (1, 1, 1, 1, 0): 9,
        (0, 1, 0, 0, 1): 10,
    }
    return gestures.get(tuple(fingers))


def action_for_hands(
    detected_hands,
    detected_hand_landmarks=None,
    detected_hand_sides=None,
):
    """Start with both open palms; accept slide and exit gestures only from left hand."""
    if len(detected_hands) == 2 and all(
        fingers == [1, 1, 1, 1, 1] for fingers in detected_hands
    ):
        return "start"

    if detected_hand_sides is None:
        if len(detected_hands) != 1:
            return None
        hand_index = 0
    else:
        hand_index = left_hand_index(detected_hand_sides)
        if hand_index is None:
            return None

    fingers = detected_hands[hand_index]
    if not any(fingers):
        return "exit"

    hand_landmarks = (
        detected_hand_landmarks[hand_index]
        if detected_hand_landmarks is not None
        else None
    )
    slide_number = slide_for_gesture(fingers, hand_landmarks)
    return f"slide:{slide_number}" if slide_number is not None else None


while True:

    success, frame = cap.read()

    if not success:
        break

    # Mirror the frame so hand movement feels natural to the person on camera.
    frame = cv2.flip(frame, 1)
    h, w, c = frame.shape

    # Convert BGR to RGB for MediaPipe
    rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    
    # Create MediaPipe image
    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_frame)
    
    # Detect hand landmarks
    detection_result = hand_landmarker.detect(mp_image)

    gesture = "Waiting..."
    detected_hands = []
    detected_hand_landmarks = []
    detected_hand_sides = []
    hand_labels = []

    if detection_result.hand_landmarks:
        for hand_index, hand_landmarks in enumerate(detection_result.hand_landmarks):
            classifications = detection_result.handedness[hand_index]
            raw_label = classifications[0].category_name if classifications else None
            hand_side = physical_hand_side(
                raw_label,
                image_is_mirrored=True,
            )
            hand_confidence = classifications[0].score if classifications else 0
            hand_labels.append(
                f"{hand_side or 'Unknown'} ({raw_label or 'no label'} {hand_confidence:.0%})"
            )
            
            # Draw hand landmarks
            for landmark in hand_landmarks:
                x = int(landmark.x * w)
                y = int(landmark.y * h)
                cv2.circle(frame, (x, y), 2, (0, 255, 0), 1)
            
            # Draw connections between landmarks
            connections = [
                (0, 1), (1, 2), (2, 3), (3, 4),          # Thumb
                (5, 6), (6, 7), (7, 8),                  # Index
                (9, 10), (10, 11), (11, 12),             # Middle
                (13, 14), (14, 15), (15, 16),            # Ring
                (17, 18), (18, 19), (19, 20),            # Pinky
                (0, 5), (5, 9), (9, 13), (13, 17), (0, 17)  # Palm
            ]
            
            for connection in connections:
                start_idx, end_idx = connection
                start = hand_landmarks[start_idx]
                end = hand_landmarks[end_idx]
                x1, y1 = int(start.x * w), int(start.y * h)
                x2, y2 = int(end.x * w), int(end.y * h)
                cv2.line(frame, (x1, y1), (x2, y2), (0, 255, 0), 1)

            # Reduce detailed landmarks to the photographed finger pose.
            detected_hands.append(fingers_up(hand_landmarks))
            detected_hand_landmarks.append(hand_landmarks)
            detected_hand_sides.append(hand_side)

    current_time = time.time()
    current_action = action_for_hands(
        detected_hands,
        detected_hand_landmarks,
        detected_hand_sides,
    )
    right_hand_index = next(
        (index for index, side in enumerate(detected_hand_sides) if side == "Right"),
        None,
    )
    has_right_hand = right_hand_index is not None
    swipe_direction = swipe_navigation.update(
        detected_hand_landmarks[right_hand_index][8].x
        if has_right_hand
        else None,
        current_time,
        right_hand_index is not None,
    )
    if swipe_direction is not None:
        pyautogui.press(swipe_direction)
        gesture = (
            "Swipe Left: Previous slide"
            if swipe_direction == "left"
            else "Swipe Right: Next slide"
        )
        candidate_action = None
        candidate_since = current_time
        no_gesture_since = current_time
        last_action = None
    elif current_action is None:
        candidate_action = None
        candidate_since = current_time
        if no_gesture_since is None:
            no_gesture_since = current_time
        elif current_time - no_gesture_since >= release_gesture_time:
            last_action = None
    else:
        no_gesture_since = None
        if current_action != candidate_action:
            candidate_action = current_action
            candidate_since = current_time

        if current_time - candidate_since < stable_gesture_time:
            gesture = "Hold gesture steady"
        else:
            gesture = "Gesture active" if current_action == last_action else "Gesture recognized"
            if current_action != last_action:
                if current_action == "start":
                    if sys.platform == "darwin":
                        pyautogui.hotkey("command", "enter")
                    else:
                        pyautogui.hotkey("ctrl", "f5")
                    gesture = "Start Slideshow"
                elif current_action == "exit":
                    pyautogui.press("esc")
                    gesture = "Exit Slideshow"
                else:
                    slide_number = int(current_action.split(":")[1])
                    pyautogui.press("home")
                    if slide_number > 1:
                        pyautogui.press(
                            "right",
                            presses=slide_number - 1,
                            interval=0.1
                        )
                    gesture = f"Go to Slide {slide_number}"
                last_action = current_action

    cv2.putText(
        frame,
        gesture,
        (30, 50),
        cv2.FONT_HERSHEY_SIMPLEX,
        1,
        (0, 255, 0),
        2
    )

    if detected_hands:
        pose_text = "Hand pattern: " + " ".join(
            "".join(str(finger) for finger in fingers)
            for fingers in detected_hands
        )
        cv2.putText(
            frame,
            pose_text,
            (30, 85),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.7,
            (0, 255, 0),
            2
        )
    hand_identity_text = (
        "Hand identity: " + ", ".join(hand_labels)
        if hand_labels
        else "Hand identity: no hands detected"
    )
    cv2.putText(
        frame,
        hand_identity_text,
        (30, 115),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.55,
        (255, 220, 80),
        2,
    )

    cv2.imshow("Google Slides Gesture Control", frame)

    # Press q in the preview window to stop the app.
    if cv2.waitKey(1) & 0xFF == ord("q"):
        break

cap.release()
cv2.destroyAllWindows()