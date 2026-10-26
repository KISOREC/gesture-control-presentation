def physical_hand_side(category_name, image_is_mirrored=False):
    label = str(category_name).casefold()
    if label not in {"left", "right"}:
        return None
    if image_is_mirrored:
        return label.title()
    return "Left" if label == "right" else "Right"


def is_right_swipe_hand(category_name, image_is_mirrored=False):
    return physical_hand_side(category_name, image_is_mirrored) == "Right"


def left_hand_index(hand_sides):
    return next(
        (index for index, side in enumerate(hand_sides) if side == "Left"),
        None,
    )


class SwipeNavigation:
    def __init__(
        self,
        distance_threshold=0.075,
        sample_window=0.4,
        cooldown=0.65,
        settle_time=0.18,
        release_time=0.7,
    ):
        self.distance_threshold = distance_threshold
        self.sample_window = sample_window
        self.cooldown = cooldown
        self.settle_time = settle_time
        self.release_time = release_time
        self.samples = []
        self.cooldown_until = 0.0
        self.swipe_suppressed = False
        self.settled_since = None
        self.hand_released_at = None

    def reset(self):
        self.samples.clear()
        self.cooldown_until = 0.0
        self.swipe_suppressed = False
        self.settled_since = None
        self.hand_released_at = None

    def update(self, screen_x, current_time, is_right_hand=False):
        if not is_right_hand or screen_x is None:
            self.samples.clear()
            self.settled_since = None
            if self.swipe_suppressed:
                if self.hand_released_at is None:
                    self.hand_released_at = current_time
                elif current_time - self.hand_released_at >= self.release_time:
                    self.swipe_suppressed = False
                    self.hand_released_at = None
            return None

        self.hand_released_at = None
        self.samples.append((screen_x, current_time))
        self.samples = [
            sample
            for sample in self.samples
            if current_time - sample[1] <= self.sample_window
        ]

        if self.swipe_suppressed:
            previous_x = self.samples[-2][0] if len(self.samples) > 1 else screen_x
            if abs(screen_x - previous_x) <= 0.012:
                if self.settled_since is None:
                    self.settled_since = current_time
                elif (
                    current_time >= self.cooldown_until
                    and current_time - self.settled_since >= self.settle_time
                ):
                    self.swipe_suppressed = False
                    self.settled_since = None
                    self.samples = [(screen_x, current_time)]
            else:
                self.settled_since = None
            return None

        if len(self.samples) < 2:
            return None

        displacement = screen_x - self.samples[0][0]
        if abs(displacement) < self.distance_threshold:
            return None

        self.cooldown_until = current_time + self.cooldown
        self.swipe_suppressed = True
        self.settled_since = None
        self.samples = [(screen_x, current_time)]
        return "left" if displacement < 0 else "right"
