package sync

// handleCall keeps each member's microphone and camera on the member, so the
// room list is what tells every client whose voice and picture to subscribe
// to. The media itself never touches the server: it goes over the MoQ relay.
//
// The host may turn either off for anyone. That is recorded on the member,
// so every client stops subscribing, and the target is told to stop sending.
// Turning the microphone or camera back on is the member's own choice and
// lifts the host's flag; a host who disagrees can still put them out.
func (r *roomConn) handleCall(sender *client, message Inbound) {
	switch message.Type {
	case "media":
		if message.Mic == nil && message.Cam == nil {
			return
		}
		if message.Mic != nil {
			sender.member.Mic = *message.Mic
			if *message.Mic {
				sender.member.HostMuted = false
			}
		}
		if message.Cam != nil {
			sender.member.Cam = *message.Cam
			if *message.Cam {
				sender.member.HostCamOff = false
			}
		}
	case "hostMute", "hostCamOff":
		if sender.id != r.controllerID {
			r.send(sender, Outbound{Type: "error", ErrCode: "not_controller"})
			return
		}
		target := r.seat(message.TargetID)
		if target == nil {
			r.send(sender, Outbound{Type: "error", ErrCode: "member_not_found"})
			return
		}
		off := false
		force := Outbound{Type: "forceMedia"}
		if message.Type == "hostMute" {
			target.member.Mic = false
			target.member.HostMuted = true
			force.Mic = &off
		} else {
			target.member.Cam = false
			target.member.HostCamOff = true
			force.Cam = &off
		}
		if r.clients[target.id] == target {
			r.send(target, force)
		}
	default:
		return
	}
	r.broadcast(Outbound{Type: "members", ControllerID: r.controllerID, Members: r.members()})
	r.touch()
}

// seat finds a member whether their socket is up or they are briefly away.
func (r *roomConn) seat(memberID string) *client {
	if connected, ok := r.clients[memberID]; ok {
		return connected
	}
	if seat, ok := r.detached[memberID]; ok {
		return seat.client
	}
	return nil
}
