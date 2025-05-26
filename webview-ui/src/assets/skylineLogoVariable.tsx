import { SVGProps } from "react"

/**
 * skylineLogoVariable component renders the skyline logo with automatic theme adaptation.
 *
 * This component uses the VS Code theme variable `--vscode-icon-foreground` for the fill color,
 * which automatically adjusts based on the active VS Code theme (light, dark, high contrast)
 * to ensure optimal contrast with the background.
 *
 * @param {SVGProps<SVGSVGElement>} props - Standard SVG props including className, style, etc.
 * @returns {JSX.Element} SVG skyline logo that adapts to VS Code themes
 */
const skylineLogoVariable = (props: SVGProps<SVGSVGElement>) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		viewBox="0 0 1218 1040"
		style={{ fill: "var(--vscode-icon-foreground)", ...props.style }}
		{...props}>
		<path
			d="M1128.217 233.475V0H88.897v233.475H.002v286.18h88.895v519.66h1039.32v-519.66h88.895v-286.18h-88.895ZM958.905 726.923H258.21v182.576h700.696V726.923ZM258.21 200.547V541.87h271.396V373.214L258.21 200.547Zm720.434-12.553-350.348 222.89V541.87h350.348V187.994Z"
			fillRule="evenodd"
			clipRule="evenodd"
		/>
	</svg>
)

export default skylineLogoVariable
