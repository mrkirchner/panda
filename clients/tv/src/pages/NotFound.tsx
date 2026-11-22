import { Text } from "@solidtv/solid";
import { theme } from "../theme";

export default function NotFound() {
  return (
    <Text x={theme.screen.gutter} y={120} fontSize={theme.font.heading} color={theme.color.text}>
      Not found
    </Text>
  );
}
