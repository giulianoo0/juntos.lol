package httpapi

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/giulianoo0/ss/internal/room"
)

// stageAuthorizer is the hub's say over who may open or run a stage: the
// host, the stage's owner, or a member the host granted that kind to.
type stageAuthorizer interface {
	memberAuthorizer
	AuthorizeStage(r *room.Room, memberID, capability, kind string, consume bool) bool
}

// authorizeStage answers the refusal itself and reports whether the caller
// may go on. consume spends a grant: pass it where the stage is opened.
func authorizeStage(c *gin.Context, authorizer stageAuthorizer, storedRoom *room.Room,
	memberID, capability, kind string, consume bool) bool {
	if authorizer == nil || !authorizer.AuthorizeMember(storedRoom.ID, memberID, capability) {
		c.JSON(http.StatusForbidden, gin.H{"error": "member_not_found"})
		return false
	}
	if !authorizer.AuthorizeStage(storedRoom, memberID, capability, kind, consume) {
		c.JSON(http.StatusForbidden, gin.H{"error": "stage_not_granted"})
		return false
	}
	return true
}
