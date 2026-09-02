package media

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Converts ASS/SSA subtitle documents to WebVTT, keeping only what WebVTT has
// vocabulary for: alignment and \pos, italics and bold, and the standard color
// classes. web/src/assvtt.ts implements the same mapping client-side.

type assStyle struct {
	italic    bool
	bold      bool
	color     string
	alignment int
}

type assDocument struct {
	playResX float64
	playResY float64
	styles   map[string]assStyle
}

var assDefaultStyle = assStyle{alignment: 2}

// vttColor is one of the eight classes the WebVTT spec gives a default color,
// in a fixed order so quantization ties resolve the same way everywhere.
type vttColor struct {
	name    string
	r, g, b int
}

var vttColors = []vttColor{
	{"white", 255, 255, 255},
	{"yellow", 255, 255, 0},
	{"cyan", 0, 255, 255},
	{"red", 255, 0, 0},
	{"lime", 0, 255, 0},
	{"magenta", 255, 0, 255},
	{"blue", 0, 0, 255},
	{"black", 0, 0, 0},
}

var assOverrideTag = regexp.MustCompile(`\\(pos|move|an|a-?[0-9]|1?c(?:&[^\\]*)?|i-?[0-9]|b-?[0-9]+|p-?[0-9]+|r)([^\\]*)`)

var assBlockPattern = regexp.MustCompile(`\{[^}]*\}`)

var assColorPattern = regexp.MustCompile(`(?i)^&?H?([0-9a-f]{1,8})&?$`)

var assPointPattern = regexp.MustCompile(`\(\s*(-?[0-9.]+)\s*,\s*(-?[0-9.]+)`)

var assStampPattern = regexp.MustCompile(`^(\d{1,2}):(\d{1,2}):(\d{1,2})[.,](\d{1,3})$`)

// ConvertASSToVTT returns nil when the document holds no renderable cue, and
// tolerates a truncated final line, so it can run over a file ffmpeg is still
// writing.
func ConvertASSToVTT(data []byte) []byte {
	text := strings.ReplaceAll(strings.ReplaceAll(string(data), "\r\n", "\n"), "\r", "\n")
	doc := parseAssDocument(text)

	type cue struct {
		start, end int
		settings   string
		text       string
	}
	var cues []cue
	var fields []string
	inEvents := false
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(raw)
		if strings.HasPrefix(line, "[") {
			inEvents = strings.EqualFold(line, "[events]")
			continue
		}
		if !inEvents {
			continue
		}
		key, value, found := strings.Cut(line, ":")
		if !found {
			continue
		}
		key = strings.ToLower(strings.TrimSpace(key))
		if key == "format" {
			fields = splitAssFormat(value)
			continue
		}
		if key != "dialogue" {
			continue
		}
		order := fields
		if order == nil {
			order = []string{"layer", "start", "end", "style", "name",
				"marginl", "marginr", "marginv", "effect", "text"}
		}
		values := splitAssFields(strings.TrimSpace(value), len(order))
		start, startOK := parseAssStamp(assField(order, values, "start"))
		end, endOK := parseAssStamp(assField(order, values, "end"))
		if !startOK || !endOK {
			continue
		}
		settings, body := convertAssCue(doc, assField(order, values, "style"), assField(order, values, "text"))
		if body == "" {
			continue
		}
		cues = append(cues, cue{start: start, end: end, settings: settings, text: body})
	}

	if len(cues) == 0 {
		return nil
	}
	sort.SliceStable(cues, func(i, j int) bool { return cues[i].start < cues[j].start })
	var out strings.Builder
	out.WriteString("WEBVTT\n")
	for _, entry := range cues {
		out.WriteString("\n" + formatVttStamp(entry.start) + " --> " + formatVttStamp(entry.end))
		if entry.settings != "" {
			out.WriteString(" " + entry.settings)
		}
		out.WriteString("\n" + entry.text + "\n")
	}
	return positionDialogueCues([]byte(out.String()))
}

const (
	bottomDialogueSetting = "line:-3"
	topDialogueSetting    = "line:2"
)

var vttTimingStamp = regexp.MustCompile(`^(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})$`)

// positionDialogueCues positions the cues of a finished WebVTT document that
// carry no settings of their own. Cues a script placed explicitly (signs) are
// left untouched, so running this twice changes nothing.
func positionDialogueCues(vtt []byte) []byte {
	lines := strings.Split(string(vtt), "\n")
	lastBottomEnd := -1
	for index, line := range lines {
		arrow := strings.Index(line, "-->")
		if arrow < 0 {
			continue
		}
		start, startOK := parseVttStampMs(strings.TrimSpace(line[:arrow]))
		endStamp, settings, _ := strings.Cut(strings.TrimSpace(line[arrow+3:]), " ")
		end, endOK := parseVttStampMs(endStamp)
		if !startOK || !endOK || settings != "" {
			continue
		}
		if start < lastBottomEnd {
			lines[index] = line + " " + topDialogueSetting
		} else {
			lastBottomEnd = end
			lines[index] = line + " " + bottomDialogueSetting
		}
	}
	return []byte(strings.Join(lines, "\n"))
}

// parseVttStampMs reads both stamp forms WebVTT allows: HH:MM:SS.mmm from our
// own converters and the short MM:SS.mmm ffmpeg writes below one hour.
func parseVttStampMs(stamp string) (int, bool) {
	match := vttTimingStamp.FindStringSubmatch(stamp)
	if match == nil {
		return 0, false
	}
	hours := 0
	if match[1] != "" {
		hours, _ = strconv.Atoi(match[1])
	}
	minutes, _ := strconv.Atoi(match[2])
	seconds, _ := strconv.Atoi(match[3])
	millis, _ := strconv.Atoi(match[4])
	return ((hours*60+minutes)*60+seconds)*1000 + millis, true
}

func parseAssDocument(text string) *assDocument {
	doc := &assDocument{playResX: 384, playResY: 288, styles: map[string]assStyle{}}
	var fields []string
	section := ""
	legacy := false
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(raw)
		if strings.HasPrefix(line, "[") {
			section = strings.ToLower(line)
			legacy = section == "[v4 styles]"
			continue
		}
		key, value, found := strings.Cut(line, ":")
		if !found {
			continue
		}
		key = strings.ToLower(strings.TrimSpace(key))
		value = strings.TrimSpace(value)
		if section == "[script info]" {
			if key == "playresx" {
				if parsed, err := strconv.Atoi(value); err == nil && parsed > 0 {
					doc.playResX = float64(parsed)
				}
			}
			if key == "playresy" {
				if parsed, err := strconv.Atoi(value); err == nil && parsed > 0 {
					doc.playResY = float64(parsed)
				}
			}
			continue
		}
		if !strings.HasSuffix(section, "styles]") {
			continue
		}
		if key == "format" {
			fields = splitAssFormat(value)
			continue
		}
		if key != "style" || fields == nil {
			continue
		}
		values := strings.Split(value, ",")
		field := func(name string) string {
			for index, candidate := range fields {
				if candidate == name && index < len(values) {
					return strings.TrimSpace(values[index])
				}
			}
			return ""
		}
		alignment := 2
		if parsed, err := strconv.Atoi(field("alignment")); err == nil {
			alignment = normalizeAssAlignment(parsed, legacy)
		}
		doc.styles[field("name")] = assStyle{
			italic:    assFlag(field("italic")),
			bold:      assFlag(field("bold")),
			color:     assColorClass(field("primarycolour")),
			alignment: alignment,
		}
	}
	return doc
}

func convertAssCue(doc *assDocument, styleName, raw string) (settings, text string) {
	style, known := doc.styles[styleName]
	if !known {
		style = assDefaultStyle
	}

	alignment := style.alignment
	var pos *[2]float64
	drawing := false
	desired := style
	var open []byte
	openColor := ""
	var out strings.Builder

	reconcile := func() {
		keep := len(open)
		for index, kind := range open {
			wanted := false
			switch kind {
			case 'i':
				wanted = desired.italic
			case 'b':
				wanted = desired.bold
			case 'c':
				wanted = desired.color == openColor
			}
			if !wanted {
				keep = index
				break
			}
		}
		for index := len(open) - 1; index >= keep; index-- {
			out.WriteString("</" + string(open[index]) + ">")
		}
		open = open[:keep]
		hasColor := false
		hasItalic := false
		hasBold := false
		for _, kind := range open {
			switch kind {
			case 'c':
				hasColor = true
			case 'i':
				hasItalic = true
			case 'b':
				hasBold = true
			}
		}
		if !hasColor {
			openColor = ""
		}
		if desired.italic && !hasItalic {
			open = append(open, 'i')
			out.WriteString("<i>")
		}
		if desired.bold && !hasBold {
			open = append(open, 'b')
			out.WriteString("<b>")
		}
		if desired.color != "" && openColor != desired.color {
			open = append(open, 'c')
			openColor = desired.color
			out.WriteString("<c." + desired.color + ">")
		}
	}

	emit := func(segment string) {
		if drawing || segment == "" {
			return
		}
		reconcile()
		out.WriteString(escapeVttText(segment))
	}

	apply := func(name, value string) {
		switch {
		case name == "pos" || name == "move":
			if point := assPointPattern.FindStringSubmatch(value); point != nil && pos == nil {
				x, errX := strconv.ParseFloat(point[1], 64)
				y, errY := strconv.ParseFloat(point[2], 64)
				if errX == nil && errY == nil {
					pos = &[2]float64{x, y}
				}
			}
		case name == "an":
			if parsed, err := strconv.Atoi(value); err == nil && parsed >= 1 && parsed <= 9 {
				alignment = parsed
			}
		case strings.HasPrefix(name, "a"):
			if parsed, err := strconv.Atoi(name[1:]); err == nil {
				alignment = normalizeAssAlignment(parsed, true)
			}
		case name == "c" || name == "1c":
			if strings.TrimSpace(value) == "" {
				desired.color = style.color
			}
		case strings.HasPrefix(name, "c&") || strings.HasPrefix(name, "1c&"):
			desired.color = assColorClass(strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(name, "1"), "c")))
		case strings.HasPrefix(name, "i"):
			desired.italic = name[1:] != "0"
		case strings.HasPrefix(name, "b"):
			weight, err := strconv.Atoi(name[1:])
			desired.bold = err == nil && (weight == 1 || weight == -1 || weight >= 700)
		case strings.HasPrefix(name, "p"):
			depth, err := strconv.Atoi(name[1:])
			drawing = err == nil && depth > 0
		case name == "r":
			target := style
			if named, ok := doc.styles[strings.TrimSpace(value)]; ok && strings.TrimSpace(value) != "" {
				target = named
			}
			desired.italic = target.italic
			desired.bold = target.bold
			desired.color = target.color
		}
	}

	last := 0
	for _, block := range assBlockPattern.FindAllStringIndex(raw, -1) {
		emit(raw[last:block[0]])
		last = block[1]
		content := raw[block[0]+1 : block[1]-1]
		for _, tag := range assOverrideTag.FindAllStringSubmatch(content, -1) {
			apply(tag[1], tag[2])
		}
	}
	emit(raw[last:])
	for index := len(open) - 1; index >= 0; index-- {
		out.WriteString("</" + string(open[index]) + ">")
	}

	text = strings.TrimSpace(strings.NewReplacer(
		`\N`, "\n", `\n`, " ", `\h`, " ",
	).Replace(out.String()))
	if text == "" {
		return "", ""
	}
	return assCueSettings(alignment, pos, doc), text
}

// assCueSettings maps the anchor grid onto VTT's line/position/align settings.
// Chromium drops a setting carrying a line alignment suffix, so a bottom-row
// anchor is approximated by lifting the box's top edge a nominal text height.
func assCueSettings(alignment int, pos *[2]float64, doc *assDocument) string {
	var parts []string
	top := alignment >= 7
	middle := alignment >= 4 && alignment <= 6
	column := alignment % 3
	if pos != nil {
		anchor := 0
		if middle {
			anchor = 3
		} else if !top {
			anchor = 6
		}
		parts = append(parts,
			fmt.Sprintf("line:%d%%", assPercent(pos[1], doc.playResY, anchor)),
			fmt.Sprintf("position:%d%%", assPercent(pos[0], doc.playResX, 0)))
	} else {
		if top {
			parts = append(parts, "line:5%")
		} else if middle {
			parts = append(parts, "line:47%")
		}
		if column == 1 {
			parts = append(parts, "position:5%")
		} else if column == 0 {
			parts = append(parts, "position:95%")
		}
	}
	if column == 1 {
		parts = append(parts, "align:left")
	} else if column == 0 {
		parts = append(parts, "align:right")
	}
	return strings.Join(parts, " ")
}

func assPercent(value, scale float64, anchor int) int {
	percent := int(value/scale*100+0.5) - anchor
	if percent < 0 {
		return 0
	}
	if percent > 100 {
		return 100
	}
	return percent
}

// assColorClass quantizes an ASS color — &HAABBGGRR& hex with alpha 0 meaning
// opaque, or plain decimal BGR in legacy scripts — to the nearest VTT color
// class. White and mostly transparent colors quantize to no class at all.
func assColorClass(value string) string {
	if value == "" {
		return ""
	}
	var parsed uint64
	if match := assColorPattern.FindStringSubmatch(value); match != nil {
		parsed, _ = strconv.ParseUint(match[1], 16, 64)
	} else {
		decimal, err := strconv.ParseUint(value, 10, 64)
		if err != nil {
			return ""
		}
		parsed = decimal
	}
	if parsed>>24&0xff >= 0xf0 {
		return ""
	}
	r, g, b := int(parsed&0xff), int(parsed>>8&0xff), int(parsed>>16&0xff)
	best := vttColors[0]
	bestDistance := 1 << 30
	for _, candidate := range vttColors {
		distance := (candidate.r-r)*(candidate.r-r) + (candidate.g-g)*(candidate.g-g) + (candidate.b-b)*(candidate.b-b)
		if distance < bestDistance {
			best = candidate
			bestDistance = distance
		}
	}
	if best.name == "white" {
		return ""
	}
	return best.name
}

// assFlag reads a style boolean, which scripts write as 0/-1 and bold
// sometimes as a font weight.
func assFlag(value string) bool {
	parsed, err := strconv.Atoi(value)
	return err == nil && (parsed == -1 || parsed == 1 || parsed >= 700)
}

// normalizeAssAlignment converts the legacy SSA encoding — 1-3 across the
// bottom, +4 for top, +8 for middle — to the numpad one.
func normalizeAssAlignment(value int, legacy bool) int {
	if !legacy {
		if value >= 1 && value <= 9 {
			return value
		}
		return 2
	}
	column := value & 3
	if column == 0 {
		return 2
	}
	if value >= 9 {
		return 3 + column
	}
	if value >= 5 {
		return 6 + column
	}
	return column
}

func splitAssFormat(value string) []string {
	fields := strings.Split(value, ",")
	for index, field := range fields {
		fields[index] = strings.ToLower(strings.TrimSpace(field))
	}
	return fields
}

// splitAssFields splits a dialogue line into its leading fields; the text
// field is last and may itself contain commas, so only count-1 are split off.
func splitAssFields(value string, count int) []string {
	parts := make([]string, 0, count)
	rest := value
	for index := 0; index < count-1; index++ {
		field, remainder, found := strings.Cut(rest, ",")
		if !found {
			break
		}
		parts = append(parts, strings.TrimSpace(field))
		rest = remainder
	}
	return append(parts, rest)
}

func assField(order, values []string, name string) string {
	for index, candidate := range order {
		if candidate == name && index < len(values) {
			return values[index]
		}
	}
	return ""
}

func parseAssStamp(stamp string) (int, bool) {
	match := assStampPattern.FindStringSubmatch(strings.TrimSpace(stamp))
	if match == nil {
		return 0, false
	}
	hours, _ := strconv.Atoi(match[1])
	minutes, _ := strconv.Atoi(match[2])
	seconds, _ := strconv.Atoi(match[3])
	fraction := match[4] + "000"[:3-len(match[4])]
	millis, _ := strconv.Atoi(fraction)
	return ((hours*60+minutes)*60+seconds)*1000 + millis, true
}

func formatVttStamp(ms int) string {
	return fmt.Sprintf("%02d:%02d:%02d.%03d", ms/3_600_000, ms/60_000%60, ms/1_000%60, ms%1_000)
}

func escapeVttText(text string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(text)
}
